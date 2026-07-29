use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const POLL_INTERVAL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageWindow {
    /// Human label for the window ("5時間", "週次", "30日"). Providers expose
    /// different window lengths, so we name them rather than hard-coding fields.
    pub label: String,
    pub utilization: f64,
    pub resets_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageInfo {
    pub tool: String,
    pub plan: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub fetched_at: u64,
}

pub struct UsageState(pub Mutex<Vec<UsageInfo>>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn iso_to_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn label_for_minutes(minutes: i64) -> String {
    if minutes < 60 {
        format!("{minutes}分")
    } else if minutes < 1440 {
        format!("{}時間", minutes / 60)
    } else if minutes == 10080 {
        "週次".to_string()
    } else {
        format!("{}日", minutes / 1440)
    }
}

// ---------------------------------------------------------------- Claude ----

fn read_claude_access_token() -> Option<String> {
    let home = std::env::var("USERPROFILE").ok()?;
    let path = PathBuf::from(home).join(".claude").join(".credentials.json");
    let data = std::fs::read_to_string(path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&data).ok()?;
    json.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(|s| s.to_string())
}

fn claude_window(body: &serde_json::Value, key: &str, label: &str) -> Option<UsageWindow> {
    let w = body.get(key)?;
    if w.is_null() {
        return None;
    }
    Some(UsageWindow {
        label: label.to_string(),
        utilization: w.get("utilization").and_then(|v| v.as_f64()).unwrap_or(0.0),
        resets_at_ms: w
            .get("resets_at")
            .and_then(|v| v.as_str())
            .and_then(iso_to_ms),
    })
}

fn fetch_claude_usage(client: &reqwest::blocking::Client) -> Option<UsageInfo> {
    let token = read_claude_access_token()?;
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-version", "2023-06-01")
        .header("User-Agent", "roost/0.1.0")
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().ok()?;
    let windows: Vec<UsageWindow> = [
        claude_window(&body, "five_hour", "5時間"),
        claude_window(&body, "seven_day", "週次"),
    ]
    .into_iter()
    .flatten()
    .collect();

    if windows.is_empty() {
        return None;
    }
    Some(UsageInfo {
        tool: "claude".into(),
        plan: None,
        windows,
        fetched_at: now_ms(),
    })
}

// ----------------------------------------------------------------- Codex ----

fn codex_binary() -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let bin_dir = PathBuf::from(base).join("OpenAI").join("Codex").join("bin");
    // The install path is versioned by a content hash, so pick the newest
    // directory that actually contains codex.exe rather than pinning one.
    let mut candidates: Vec<(SystemTime, PathBuf)> = std::fs::read_dir(&bin_dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let exe = entry.path().join("codex.exe");
            if !exe.is_file() {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, exe))
        })
        .collect();
    candidates.sort_by_key(|(modified, _)| *modified);
    candidates.pop().map(|(_, exe)| exe)
}

fn codex_window(value: &serde_json::Value) -> Option<UsageWindow> {
    if value.is_null() {
        return None;
    }
    let minutes = value.get("windowDurationMins").and_then(|v| v.as_i64())?;
    Some(UsageWindow {
        label: label_for_minutes(minutes),
        utilization: value.get("usedPercent").and_then(|v| v.as_f64()).unwrap_or(0.0),
        // The app server reports reset times in whole seconds.
        resets_at_ms: value
            .get("resetsAt")
            .and_then(|v| v.as_i64())
            .map(|secs| secs * 1000),
    })
}

/// Codex has no plain HTTP endpoint for current utilization — the percentages
/// only ride on response headers of real model calls. Its own TUI reads them
/// through the local `codex app-server` JSON-RPC service, so we ask the same
/// way instead of burning quota on a throwaway completion request.
fn fetch_codex_usage() -> Option<UsageInfo> {
    let exe = codex_binary()?;
    let mut command = Command::new(exe);
    command
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    // codex.exe is a console program, so Windows would pop a console window for
    // it on every poll without this. Nothing here is interactive.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().ok()?;

    let result = (|| {
        let mut stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let mut reader = BufReader::new(stdout);

        let init = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "clientInfo": {
                "name": "roost", "title": "Roost", "version": "0.1.0"
            }}
        });
        writeln!(stdin, "{init}").ok()?;
        writeln!(stdin, "{}", serde_json::json!({
            "jsonrpc": "2.0", "method": "initialized", "params": {}
        })).ok()?;
        writeln!(stdin, "{}", serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {}
        })).ok()?;
        stdin.flush().ok()?;

        // The server interleaves unsolicited notifications, so read until we
        // see the response carrying our id rather than taking the first line.
        for _ in 0..40 {
            let mut line = String::new();
            if reader.read_line(&mut line).ok()? == 0 {
                return None;
            }
            let msg: serde_json::Value = match serde_json::from_str(line.trim()) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if msg.get("id").and_then(|v| v.as_i64()) != Some(2) {
                continue;
            }
            let limits = msg.get("result")?.get("rateLimits")?;
            let windows: Vec<UsageWindow> = ["primary", "secondary"]
                .iter()
                .filter_map(|key| limits.get(*key).and_then(codex_window))
                .collect();
            if windows.is_empty() {
                return None;
            }
            return Some(UsageInfo {
                tool: "codex".into(),
                plan: limits
                    .get("planType")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                windows,
                fetched_at: now_ms(),
            });
        }
        None
    })();

    let _ = child.kill();
    let _ = child.wait();
    result
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageAlert {
    pub tool: String,
    pub label: String,
    pub utilization: f64,
    pub threshold: u8,
}

/// Emits one alert per threshold crossing rather than one per poll, and clears
/// the memory when utilization falls back below it so the next billing window
/// warns again.
fn collect_alerts(
    all: &[UsageInfo],
    thresholds: &[u8],
    alerted: &mut HashMap<String, u8>,
) -> Vec<UsageAlert> {
    let mut out = Vec::new();
    for info in all {
        for window in &info.windows {
            let key = format!("{}:{}", info.tool, window.label);
            let highest = thresholds
                .iter()
                .filter(|t| window.utilization >= **t as f64)
                .max()
                .copied();

            match highest {
                Some(threshold) => {
                    if alerted.get(&key).copied().unwrap_or(0) < threshold {
                        alerted.insert(key, threshold);
                        out.push(UsageAlert {
                            tool: info.tool.clone(),
                            label: window.label.clone(),
                            utilization: window.utilization,
                            threshold,
                        });
                    }
                }
                None => {
                    alerted.remove(&key);
                }
            }
        }
    }
    out
}

pub fn spawn(app: AppHandle, state: Arc<UsageState>, app_state: Arc<crate::state::AppState>) {
    std::thread::spawn(move || {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut alerted: HashMap<String, u8> = HashMap::new();
        loop {
            let all: Vec<UsageInfo> = [fetch_claude_usage(&client), fetch_codex_usage()]
                .into_iter()
                .flatten()
                .collect();
            if !all.is_empty() {
                *state.0.lock().unwrap() = all.clone();
                let _ = app.emit("usage-updated", &all);

                let thresholds = app_state.settings.lock().unwrap().usage_alert_at.clone();
                for alert in collect_alerts(&all, &thresholds, &mut alerted) {
                    let _ = app.emit("usage-alert", &alert);
                }
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(tool: &str, label: &str, utilization: f64) -> UsageInfo {
        UsageInfo {
            tool: tool.into(),
            plan: None,
            windows: vec![UsageWindow {
                label: label.into(),
                utilization,
                resets_at_ms: None,
            }],
            fetched_at: 0,
        }
    }

    #[test]
    fn alerts_once_per_threshold_then_escalates_and_resets() {
        let thresholds = [80u8, 95];
        let mut alerted = HashMap::new();

        assert!(collect_alerts(&[info("claude", "5時間", 42.0)], &thresholds, &mut alerted).is_empty());

        let first = collect_alerts(&[info("claude", "5時間", 81.0)], &thresholds, &mut alerted);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].threshold, 80);

        // Still over 80 but not yet 95 — must not nag on every poll.
        assert!(collect_alerts(&[info("claude", "5時間", 85.0)], &thresholds, &mut alerted).is_empty());

        let second = collect_alerts(&[info("claude", "5時間", 96.0)], &thresholds, &mut alerted);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].threshold, 95);

        // New window: dropping below every threshold re-arms the alerts.
        assert!(collect_alerts(&[info("claude", "5時間", 3.0)], &thresholds, &mut alerted).is_empty());
        let after_reset = collect_alerts(&[info("claude", "5時間", 82.0)], &thresholds, &mut alerted);
        assert_eq!(after_reset.len(), 1);
        assert_eq!(after_reset[0].threshold, 80);
    }

    #[test]
    fn tools_and_windows_are_tracked_independently() {
        let thresholds = [80u8];
        let mut alerted = HashMap::new();
        let all = vec![info("claude", "5時間", 90.0), info("codex", "30日", 90.0)];
        assert_eq!(collect_alerts(&all, &thresholds, &mut alerted).len(), 2);
        assert!(collect_alerts(&all, &thresholds, &mut alerted).is_empty());
    }
}
