use crate::state::{AgentSession, AppState, PermissionRequest};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Response, Server};

const PORT_RANGE: std::ops::Range<u16> = 47821..47831;

fn port_file() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let dir = PathBuf::from(base).join("Roost");
    let _ = fs::create_dir_all(&dir);
    dir.join("port.txt")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn json_header() -> Header {
    Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()
}

pub fn spawn(app: AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut server = None;
        let mut bound_port = 0u16;
        for port in PORT_RANGE {
            if let Ok(s) = Server::http(("127.0.0.1", port)) {
                bound_port = port;
                server = Some(s);
                break;
            }
        }
        let server = match server {
            Some(s) => s,
            None => {
                eprintln!("roost: failed to bind local event server");
                return;
            }
        };
        let _ = fs::write(port_file(), bound_port.to_string());
        println!("roost: event server listening on 127.0.0.1:{bound_port}");

        let server = Arc::new(server);
        loop {
            let request = match server.recv() {
                Ok(r) => r,
                Err(_) => continue,
            };
            let app = app.clone();
            let state = state.clone();
            std::thread::spawn(move || handle(request, app, state));
        }
    });
}

enum BodyError {
    /// Fewer bytes arrived than Content-Length promised — a transport problem,
    /// so the caller should retry or fall back rather than treat it as an answer.
    Incomplete,
    /// The bytes arrived intact but aren't UTF-8. That's a malformed request.
    NotUtf8,
}

/// Reads the whole body and verifies it against Content-Length. Distinguishing
/// these two failures matters: the permission hook must be able to tell "the
/// connection hiccuped" from "you sent garbage", and only ever act on a real
/// decision.
fn read_body(request: &mut tiny_http::Request) -> Result<String, BodyError> {
    let expected = request.body_length();
    let mut buf = Vec::with_capacity(expected.unwrap_or(0));
    if request.as_reader().read_to_end(&mut buf).is_err() {
        return Err(BodyError::Incomplete);
    }
    if expected.is_some_and(|expected| buf.len() != expected) {
        return Err(BodyError::Incomplete);
    }
    String::from_utf8(buf).map_err(|_| BodyError::NotUtf8)
}

fn handle(mut request: tiny_http::Request, app: AppHandle, state: Arc<AppState>) {
    let method = request.method().clone();
    let url = request.url().to_string();

    let body = match read_body(&mut request) {
        Ok(b) => b,
        Err(err) => {
            let (status, message) = match err {
                BodyError::Incomplete => (503, "incomplete body"),
                BodyError::NotUtf8 => (400, "body is not valid utf-8"),
            };
            let response = Response::from_string(json!({ "error": message }).to_string())
                .with_status_code(status)
                .with_header(json_header());
            let _ = request.respond(response);
            return;
        }
    };

    let (status, payload) = match (&method, url.as_str()) {
        (Method::Get, "/health") => (200, json!({ "ok": true })),
        (Method::Post, "/event") => handle_event(&body, &app, &state),
        (Method::Post, "/permission") => handle_permission(&body, &app, &state),
        _ => (404, json!({ "error": "not found" })),
    };

    let data = payload.to_string();
    let response = Response::from_string(data)
        .with_status_code(status)
        .with_header(json_header());
    let _ = request.respond(response);
}

fn handle_event(body: &str, app: &AppHandle, state: &Arc<AppState>) -> (u16, serde_json::Value) {
    #[derive(serde::Deserialize)]
    struct EventBody {
        session_id: String,
        tool: String,
        label: Option<String>,
        status: String,
        message: Option<String>,
        terminal: Option<crate::state::TerminalRef>,
        question: Option<crate::state::QuestionInfo>,
    }

    let parsed: Result<EventBody, _> = serde_json::from_str(body);
    let parsed = match parsed {
        Ok(p) => p,
        Err(e) => return (400, json!({ "error": e.to_string() })),
    };

    let mut session = AgentSession {
        session_id: parsed.session_id.clone(),
        tool: parsed.tool,
        label: parsed.label,
        status: parsed.status,
        message: parsed.message,
        terminal: parsed.terminal,
        question: parsed.question,
        updated_at: now_ms(),
    };

    {
        let mut sessions = state.sessions.lock().unwrap();

        // A session that ends while a question is on screen ("closed") was cut
        // short — keep the question so the user can still see what was being
        // asked. "done" means the turn completed normally, so the question was
        // answered and carrying it over would just be stale noise.
        if session.status == "closed" && session.question.is_none() {
            if let Some(prev) = sessions.get(&parsed.session_id) {
                if prev.status == "waiting_input" {
                    session.question = prev.question.clone();
                }
            }
        }

        sessions.insert(parsed.session_id.clone(), session);
        crate::state::prune_history(&mut sessions);
    }

    broadcast_sessions(app, state);
    (200, json!({ "ok": true }))
}

fn handle_permission(
    body: &str,
    app: &AppHandle,
    state: &Arc<AppState>,
) -> (u16, serde_json::Value) {
    #[derive(serde::Deserialize)]
    struct PermissionBody {
        session_id: String,
        tool: String,
        label: Option<String>,
        tool_name: String,
        description: String,
    }

    let parsed: Result<PermissionBody, _> = serde_json::from_str(body);
    let parsed = match parsed {
        Ok(p) => p,
        Err(e) => return (400, json!({ "error": e.to_string() })),
    };

    let id = uuid::Uuid::new_v4().to_string();
    let req = PermissionRequest {
        id: id.clone(),
        session_id: parsed.session_id,
        tool: parsed.tool,
        label: parsed.label,
        tool_name: parsed.tool_name,
        description: parsed.description,
    };

    let (tx, rx) = mpsc::channel::<String>();
    {
        let mut pending = state.pending_permissions.lock().unwrap();
        pending.insert(id.clone(), req.clone());
        let mut channels = state.permission_channels.lock().unwrap();
        channels.insert(id.clone(), tx);
    }
    let _ = app.emit("permission-requested", &req);

    let decision = rx
        .recv_timeout(Duration::from_secs(300))
        .unwrap_or_else(|_| "deny".to_string());

    {
        let mut pending = state.pending_permissions.lock().unwrap();
        pending.remove(&id);
        let mut channels = state.permission_channels.lock().unwrap();
        channels.remove(&id);
    }
    let _ = app.emit("permission-resolved", &id);

    (200, json!({ "decision": decision }))
}

pub fn broadcast_sessions(app: &AppHandle, state: &Arc<AppState>) {
    let sessions = state.sessions.lock().unwrap();
    let list: Vec<&AgentSession> = sessions.values().collect();
    let _ = app.emit("sessions-updated", &list);
}
