mod server;
mod state;
mod usage;
mod winfocus;

use state::{AgentSession, AppState, PermissionRequest, Settings};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewWindow};
use usage::{UsageInfo, UsageState};

#[tauri::command]
fn get_sessions(state: tauri::State<Arc<AppState>>) -> Vec<AgentSession> {
    state.sessions.lock().unwrap().values().cloned().collect()
}

#[tauri::command]
fn get_pending_permissions(state: tauri::State<Arc<AppState>>) -> Vec<PermissionRequest> {
    state
        .pending_permissions
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect()
}

#[tauri::command]
fn respond_permission(id: String, decision: String, state: tauri::State<Arc<AppState>>) -> bool {
    let channels = state.permission_channels.lock().unwrap();
    if let Some(tx) = channels.get(&id) {
        let _ = tx.send(decision);
        true
    } else {
        false
    }
}

#[tauri::command]
fn focus_terminal(pid: u32) -> bool {
    winfocus::focus_pid(pid)
}

#[tauri::command]
fn get_window_title(pid: u32) -> Option<String> {
    winfocus::window_title_for_pid(pid)
}

#[tauri::command]
fn get_approval_mode(state: tauri::State<Arc<AppState>>) -> bool {
    *state.approval_mode.lock().unwrap()
}

#[tauri::command]
fn set_approval_mode(enabled: bool, state: tauri::State<Arc<AppState>>) -> bool {
    if state::write_approval_mode(enabled).is_err() {
        return false;
    }
    *state.approval_mode.lock().unwrap() = enabled;
    true
}

#[tauri::command]
fn get_usage(state: tauri::State<Arc<UsageState>>) -> Vec<UsageInfo> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn toggle_overlay(window: WebviewWindow) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Resolves the configured monitor, falling back to the primary one when the
/// setting is empty or names a display that's no longer attached.
fn target_monitor(window: &WebviewWindow, settings: &Settings) -> Option<tauri::Monitor> {
    if !settings.monitor.is_empty() {
        if let Ok(monitors) = window.available_monitors() {
            if let Some(found) = monitors
                .into_iter()
                .find(|m| m.name().map(|n| n == &settings.monitor).unwrap_or(false))
            {
                return Some(found);
            }
        }
    }
    window.primary_monitor().ok().flatten()
}

/// Re-anchors the window. Called on startup and whenever the size changes, so a
/// growing panel expands symmetrically instead of drifting.
fn position_overlay(window: &WebviewWindow, settings: &Settings) {
    let Some(monitor) = target_monitor(window, settings) else {
        return;
    };
    let Ok(win_size) = window.outer_size() else {
        return;
    };
    // Monitor position matters once a second display is attached — a secondary
    // screen's origin is not (0, 0).
    let origin = monitor.position();
    let screen = monitor.size();
    let scale = monitor.scale_factor();
    let margin = 12.0 * scale;

    let offset_x = match settings.anchor.as_str() {
        "left" => margin,
        "right" => screen.width as f64 - win_size.width as f64 - margin,
        _ => (screen.width as f64 / 2.0) - (win_size.width as f64 / 2.0),
    };
    let x = origin.x as f64 + offset_x.max(0.0);
    let y = origin.y as f64 + settings.top_offset as f64 * scale;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

#[tauri::command]
fn list_monitors(window: WebviewWindow) -> Vec<String> {
    window
        .available_monitors()
        .map(|monitors| {
            monitors
                .into_iter()
                .filter_map(|m| m.name().cloned())
                .collect()
        })
        .unwrap_or_default()
}

fn toggle_window(window: &WebviewWindow) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Re-registers the visibility shortcut. Unregisters everything first so a
/// changed binding doesn't leave the old one live.
fn apply_hotkey(app: &tauri::AppHandle, accelerator: &str) -> bool {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let shortcut = app.global_shortcut();
    let _ = shortcut.unregister_all();
    if accelerator.is_empty() {
        return true;
    }
    shortcut.on_shortcut(accelerator, move |app, _shortcut, event| {
        // Fire on press only; without this the toggle runs twice per keypress.
        if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
            return;
        }
        if let Some(window) = app.get_webview_window("overlay") {
            toggle_window(&window);
        }
    })
    .is_ok()
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(enabled: bool, app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.is_ok()
}

#[tauri::command]
fn get_settings(state: tauri::State<Arc<AppState>>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(
    settings: Settings,
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<Arc<AppState>>,
) -> bool {
    if state::write_settings(&settings).is_err() {
        return false;
    }
    let hotkey_changed = state.settings.lock().unwrap().hotkey != settings.hotkey;
    *state.settings.lock().unwrap() = settings.clone();
    position_overlay(&window, &settings);
    if hotkey_changed {
        apply_hotkey(&app, &settings.hotkey);
    }
    true
}

/// The frontend calls this after every layout change: it measures its own
/// content, then asks us to resize and re-anchor in one step.
#[tauri::command]
fn resize_overlay(width: f64, height: f64, window: WebviewWindow, state: tauri::State<Arc<AppState>>) {
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    let settings = state.settings.lock().unwrap().clone();
    position_overlay(&window, &settings);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState::new());
    let usage_state = Arc::new(UsageState(std::sync::Mutex::new(Vec::new())));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(app_state.clone())
        .manage(usage_state.clone())
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            get_pending_permissions,
            respond_permission,
            focus_terminal,
            toggle_overlay,
            get_usage,
            get_window_title,
            get_approval_mode,
            set_approval_mode,
            get_settings,
            set_settings,
            resize_overlay,
            list_monitors,
            get_autostart,
            set_autostart,
        ])
        .setup(move |app| {
            let window = app
                .get_webview_window("overlay")
                .expect("overlay window must exist");
            let initial = app_state.settings.lock().unwrap().clone();
            position_overlay(&window, &initial);
            let _ = window.show();

            server::spawn(app.handle().clone(), app_state.clone());
            usage::spawn(
                app.handle().clone(),
                usage_state.clone(),
                app_state.clone(),
            );
            apply_hotkey(app.handle(), &initial.hotkey);

            let show_hide = MenuItem::with_id(app, "toggle", "表示/非表示", true, None::<&str>)?;
            // Escape hatch: approval mode gates every tool call, so it must be
            // switchable off without needing to reach the overlay UI.
            let disable_approval = MenuItem::with_id(
                app,
                "disable-approval",
                "承認モードを解除",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_hide, &disable_approval, &quit])?;

            let tray_state = app_state.clone();
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Roost")
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "toggle" => {
                        if let Some(w) = app.get_webview_window("overlay") {
                            toggle_window(&w);
                        }
                    }
                    "disable-approval" => {
                        let _ = state::write_approval_mode(false);
                        *tray_state.approval_mode.lock().unwrap() = false;
                        // Release anything already blocked so the agent isn't
                        // left hanging on a prompt nobody can answer.
                        let channels = tray_state.permission_channels.lock().unwrap();
                        for tx in channels.values() {
                            let _ = tx.send("allow".to_string());
                        }
                        let _ = app.emit("approval-mode-changed", false);
                    }
                    "quit" => {
                        let _ = state::write_approval_mode(false);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let _ = app.emit("ready", ());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
