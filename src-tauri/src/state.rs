use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// How many finished sessions to keep around after they stop running. Sessions
/// still waiting on the user are never pruned regardless of this cap.
pub const HISTORY_LIMIT: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalRef {
    pub app: Option<String>,
    pub pid: Option<u32>,
    pub window_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionInfo {
    pub header: Option<String>,
    pub text: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSession {
    pub session_id: String,
    pub tool: String,
    pub label: Option<String>,
    pub status: String,
    pub message: Option<String>,
    pub terminal: Option<TerminalRef>,
    pub question: Option<QuestionInfo>,
    #[serde(default)]
    pub is_background: bool,
    pub updated_at: u64,
}

impl AgentSession {
    pub fn is_active(&self) -> bool {
        !matches!(self.status.as_str(), "done" | "closed")
    }

    /// A session the user still owes an answer to — these stay visible even
    /// after the agent stops running.
    pub fn needs_attention(&self) -> bool {
        matches!(self.status.as_str(), "waiting_input" | "waiting_permission" | "error")
            || self.question.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub id: String,
    pub session_id: String,
    pub tool: String,
    pub label: Option<String>,
    pub tool_name: String,
    pub description: String,
}

/// Older settings files won't have the newer keys, so every field has a default
/// and deserialization tolerates their absence rather than falling back to a
/// wholesale reset that would silently discard the user's layout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Width of the expanded panel, in logical pixels.
    pub width: u32,
    /// Horizontal placement on the chosen monitor.
    pub anchor: String,
    /// Gap from the top edge, in logical pixels.
    pub top_offset: u32,
    /// Collapse the panel automatically when the pointer leaves it.
    pub collapse_on_leave: bool,
    /// Monitor to show on. Empty, or a name that no longer exists, falls back
    /// to the primary monitor.
    pub monitor: String,
    /// Tauri accelerator that toggles visibility. Empty disables the shortcut.
    pub hotkey: String,
    /// Warn once per threshold when a usage window crosses these percentages.
    pub usage_alert_at: Vec<u8>,
    /// Flag a "running" session as stalled after this many minutes with no
    /// update. Zero disables the check.
    pub stall_after_minutes: u32,
    /// Stop showing a finished session this many minutes after it ended. Zero
    /// keeps them listed until dismissed. Sessions still owed an answer are
    /// never hidden by this — see `AgentSession::needs_attention`.
    pub hide_finished_after_minutes: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            width: 400,
            anchor: "center".into(),
            top_offset: 6,
            collapse_on_leave: true,
            monitor: String::new(),
            hotkey: "Alt+Shift+V".into(),
            usage_alert_at: vec![80, 95],
            stall_after_minutes: 20,
            hide_finished_after_minutes: 5,
        }
    }
}

pub struct AppState {
    pub sessions: Mutex<HashMap<String, AgentSession>>,
    pub pending_permissions: Mutex<HashMap<String, PermissionRequest>>,
    pub permission_channels: Mutex<HashMap<String, Sender<String>>>,
    pub approval_mode: Mutex<bool>,
    pub settings: Mutex<Settings>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending_permissions: Mutex::new(HashMap::new()),
            permission_channels: Mutex::new(HashMap::new()),
            approval_mode: Mutex::new(read_approval_mode()),
            settings: Mutex::new(read_settings()),
        }
    }
}

fn state_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let dir = PathBuf::from(base).join("Roost");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Writes via a temp file + rename so a reader never sees a half-written file.
fn write_atomic(path: &PathBuf, body: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)?;
    fs::rename(&tmp, path)
}

pub fn approval_mode_path() -> PathBuf {
    state_dir().join("approval-mode.json")
}

fn settings_path() -> PathBuf {
    state_dir().join("settings.json")
}

fn read_approval_mode() -> bool {
    fs::read_to_string(approval_mode_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("enabled").and_then(|e| e.as_bool()))
        .unwrap_or(false)
}

pub fn write_approval_mode(enabled: bool) -> std::io::Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let body = serde_json::json!({ "enabled": enabled, "updated_at": now }).to_string();
    write_atomic(&approval_mode_path(), &body)
}

fn read_settings() -> Settings {
    fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default()
}

pub fn write_settings(settings: &Settings) -> std::io::Result<()> {
    let body = serde_json::to_string(settings).unwrap_or_default();
    write_atomic(&settings_path(), &body)
}

/// Drops the oldest finished sessions once we exceed `HISTORY_LIMIT`. Active
/// sessions and anything still waiting on the user are kept unconditionally.
pub fn prune_history(sessions: &mut HashMap<String, AgentSession>) {
    let mut finished: Vec<(String, u64)> = sessions
        .values()
        .filter(|s| !s.is_active() && !s.needs_attention())
        .map(|s| (s.session_id.clone(), s.updated_at))
        .collect();

    if finished.len() <= HISTORY_LIMIT {
        return;
    }
    finished.sort_by_key(|(_, updated_at)| *updated_at);
    for (id, _) in finished.iter().take(finished.len() - HISTORY_LIMIT) {
        sessions.remove(id);
    }
}

/// Drops every finished session the user has nothing left to do with, and
/// returns how many went. A session still holding a question survives: it is
/// finished, but losing it would take the question with it, and the user asked
/// to clear clutter — not to throw away something they still have to answer.
pub fn clear_finished(sessions: &mut HashMap<String, AgentSession>) -> usize {
    let before = sessions.len();
    sessions.retain(|_, s| s.is_active() || s.needs_attention());
    before - sessions.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, status: &str, question: bool) -> AgentSession {
        AgentSession {
            session_id: id.into(),
            tool: "claude".into(),
            label: None,
            status: status.into(),
            message: None,
            terminal: None,
            question: question.then(|| QuestionInfo {
                header: None,
                text: "which one?".into(),
                options: vec!["a".into()],
            }),
            is_background: false,
            updated_at: 0,
        }
    }

    fn map(list: Vec<AgentSession>) -> HashMap<String, AgentSession> {
        list.into_iter()
            .map(|s| (s.session_id.clone(), s))
            .collect()
    }

    #[test]
    fn clears_plain_finished_sessions() {
        let mut sessions = map(vec![
            session("done", "done", false),
            session("closed", "closed", false),
        ]);
        assert_eq!(clear_finished(&mut sessions), 2);
        assert!(sessions.is_empty());
    }

    #[test]
    fn keeps_running_sessions() {
        let mut sessions = map(vec![
            session("live", "running", false),
            session("old", "done", false),
        ]);
        assert_eq!(clear_finished(&mut sessions), 1);
        assert!(sessions.contains_key("live"));
    }

    /// The important one: a session cut short mid-question is "closed", so a
    /// naive status check would sweep away the very thing the user still has to
    /// answer.
    #[test]
    fn keeps_finished_sessions_that_still_hold_a_question() {
        let mut sessions = map(vec![
            session("asked", "closed", true),
            session("plain", "closed", false),
        ]);
        assert_eq!(clear_finished(&mut sessions), 1);
        assert!(sessions.contains_key("asked"));
    }
}
