import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cueForStatus, isMuted, playCue, setMuted } from "./sounds";
import "./App.css";

type QuestionInfo = {
  header: string | null;
  text: string;
  options: string[];
};

type AgentSession = {
  session_id: string;
  tool: string;
  label: string | null;
  status: "running" | "waiting_permission" | "waiting_input" | "done" | "closed" | "error" | string;
  message: string | null;
  terminal: { app: string | null; pid: number | null; window_title: string | null } | null;
  question: QuestionInfo | null;
  updated_at: number;
};

type PermissionRequest = {
  id: string;
  session_id: string;
  tool: string;
  label: string | null;
  tool_name: string;
  description: string;
};

type UsageWindow = {
  label: string;
  utilization: number;
  resets_at_ms: number | null;
};

type UsageInfo = {
  tool: string;
  plan: string | null;
  windows: UsageWindow[];
  fetched_at: number;
};

type Settings = {
  width: number;
  anchor: "left" | "center" | "right" | string;
  top_offset: number;
  collapse_on_leave: boolean;
  monitor: string;
  hotkey: string;
  usage_alert_at: number[];
  stall_after_minutes: number;
};

type UsageAlertEvent = {
  tool: string;
  label: string;
  utilization: number;
  threshold: number;
};

const HOTKEY_CHOICES = ["Alt+Shift+V", "Ctrl+Shift+V", "Alt+Shift+I", ""];

const TOOL_COLORS: Record<string, string> = {
  claude: "#d97757",
  codex: "#10a37f",
  gemini: "#4285f4",
  cursor: "#6b6bff",
};

const TOOL_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  cursor: "Cursor",
};

function toolColor(tool: string) {
  return TOOL_COLORS[tool.toLowerCase()] ?? "#8a8a8a";
}

function isFinished(status: string) {
  return status === "done" || status === "closed";
}

function elapsed(updatedAt: number) {
  const secs = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m`;
}

function countdown(resetsAtMs: number | null) {
  if (!resetsAtMs) return "";
  const ms = resetsAtMs - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "まもなく";
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}日${hours % 24}時間後`;
  if (hours > 0) return `${hours}時間${mins % 60}分後`;
  return `${mins}分後`;
}

function usageSeverity(utilization: number) {
  if (utilization >= 90) return "danger";
  if (utilization >= 70) return "warn";
  return "normal";
}

/// A session that claims to be running but hasn't reported anything for a long
/// time is usually stuck — worth surfacing, since nothing else would say so.
function isStalled(session: AgentSession, afterMinutes: number) {
  if (afterMinutes <= 0 || session.status !== "running") return false;
  return Date.now() - session.updated_at > afterMinutes * 60_000;
}

function statusLabel(status: string) {
  switch (status) {
    case "running":
      return "実行中";
    case "waiting_permission":
      return "承認待ち";
    case "waiting_input":
      return "入力待ち";
    case "error":
      return "エラー";
    case "done":
      return "完了";
    case "closed":
      return "終了";
    default:
      return status;
  }
}

/** Active sessions first, then finished ones, each newest-first. */
function sortSessions(list: AgentSession[]) {
  return [...list].sort((a, b) => {
    const aFin = isFinished(a.status) ? 1 : 0;
    const bFin = isFinished(b.status) ? 1 : 0;
    if (aFin !== bFin) return aFin - bFin;
    return b.updated_at - a.updated_at;
  });
}

export default function App() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [usage, setUsage] = useState<UsageInfo[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [monitors, setMonitors] = useState<string[]>([]);
  const [autostart, setAutostart] = useState(false);
  const [usageAlerts, setUsageAlerts] = useState<UsageAlertEvent[]>([]);
  const [approvalMode, setApprovalMode] = useState(false);
  const [muted, setMutedState] = useState(isMuted);
  const [hovered, setHovered] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmApproval, setConfirmApproval] = useState(false);
  const [, forceTick] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // The panel stays open while it holds something the user must act on, so a
  // permission prompt can't vanish the moment the pointer drifts away.
  const needsAction = permissions.length > 0;
  const expanded = hovered || needsAction || showSettings;

  useEffect(() => {
    invoke<AgentSession[]>("get_sessions").then((s) => setSessions(sortSessions(s))).catch(() => {});
    invoke<PermissionRequest[]>("get_pending_permissions").then(setPermissions).catch(() => {});
    invoke<UsageInfo[]>("get_usage").then(setUsage).catch(() => {});
    invoke<boolean>("get_approval_mode").then(setApprovalMode).catch(() => {});
    invoke<Settings>("get_settings").then(setSettings).catch(() => {});
    invoke<string[]>("list_monitors").then(setMonitors).catch(() => {});
    invoke<boolean>("get_autostart").then(setAutostart).catch(() => {});

    const unlistenSessions = listen<AgentSession[]>("sessions-updated", (e) => {
      for (const s of e.payload) {
        const cue = cueForStatus(s.status);
        if (cue) playCue(cue, `${s.session_id}:${s.status}`);
      }
      setSessions(sortSessions(e.payload));
    });
    const unlistenPermReq = listen<PermissionRequest>("permission-requested", (e) => {
      playCue("attention", `perm:${e.payload.id}`);
      setPermissions((prev) => [...prev, e.payload]);
    });
    const unlistenPermResolved = listen<string>("permission-resolved", (e) => {
      setPermissions((prev) => prev.filter((p) => p.id !== e.payload));
    });
    const unlistenUsage = listen<UsageInfo[]>("usage-updated", (e) => setUsage(e.payload));
    const unlistenUsageAlert = listen<UsageAlertEvent>("usage-alert", (e) => {
      playCue("error", `usage:${e.payload.tool}:${e.payload.label}:${e.payload.threshold}`);
      // Keep only the newest alert per window so repeated escalations replace
      // rather than stack up.
      setUsageAlerts((prev) => [
        ...prev.filter((a) => !(a.tool === e.payload.tool && a.label === e.payload.label)),
        e.payload,
      ]);
    });
    // The tray menu can disable approval mode without going through the UI.
    const unlistenApproval = listen<boolean>("approval-mode-changed", (e) => {
      setApprovalMode(e.payload);
      setConfirmApproval(false);
    });

    const tick = setInterval(() => forceTick((n) => n + 1), 30000);

    return () => {
      unlistenSessions.then((f) => f());
      unlistenPermReq.then((f) => f());
      unlistenPermResolved.then((f) => f());
      unlistenUsage.then((f) => f());
      unlistenUsageAlert.then((f) => f());
      unlistenApproval.then((f) => f());
      clearInterval(tick);
    };
  }, []);

  // Measure after paint so the window never lags a frame behind the content.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    invoke("resize_overlay", {
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
    }).catch(() => {});
  }, [sessions, permissions, usage, expanded, showSettings, settings]);

  const hasAttention =
    permissions.length > 0 ||
    sessions.some((s) => s.status === "waiting_permission" || s.status === "error");
  const activeCount = sessions.filter((s) => !isFinished(s.status)).length;

  const respond = useCallback(async (id: string, decision: "allow" | "deny") => {
    await invoke("respond_permission", { id, decision });
  }, []);

  const jump = useCallback(async (pid: number | null | undefined) => {
    if (!pid) return;
    await invoke("focus_terminal", { pid });
  }, []);

  async function applyApprovalMode(enabled: boolean) {
    const ok = await invoke<boolean>("set_approval_mode", { enabled }).catch(() => false);
    if (ok) setApprovalMode(enabled);
    setConfirmApproval(false);
  }

  // Turning this on gates every tool call, so a stray click must not enable it.
  // Off is the safe direction and stays one click.
  function onApprovalButton() {
    if (approvalMode) void applyApprovalMode(false);
    else setConfirmApproval((v) => !v);
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  async function toggleAutostart() {
    const next = !autostart;
    const ok = await invoke<boolean>("set_autostart", { enabled: next }).catch(() => false);
    if (ok) setAutostart(next);
  }

  async function updateSettings(patch: Partial<Settings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await invoke("set_settings", { settings: next }).catch(() => {});
  }

  const panelWidth = expanded ? (settings?.width ?? 400) : undefined;

  return (
    <div
      ref={rootRef}
      className={`capsule ${expanded ? "expanded" : "collapsed"} ${hasAttention ? "attention" : ""}`}
      style={panelWidth ? { width: panelWidth } : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        if (settings?.collapse_on_leave !== false) {
          setHovered(false);
          setShowSettings(false);
        }
      }}
    >
      <div className="capsule-header">
        <span className="dot-row">
          {sessions.length === 0 && <span className="idle-text">Vibe Island</span>}
          {sessions.map((s) => (
            <span
              key={s.session_id}
              className={`tool-dot ${isFinished(s.status) ? "finished" : ""}`}
              style={{ background: toolColor(s.tool) }}
              title={`${TOOL_LABELS[s.tool] ?? s.tool} — ${statusLabel(s.status)}`}
            />
          ))}
        </span>
        <span className="header-right">
          {!expanded && activeCount > 0 && <span className="mini-count">{activeCount}</span>}
          {permissions.length > 0 && <span className="badge">{permissions.length}</span>}
        </span>
      </div>

      {expanded && (
        <div className="capsule-body">
          {permissions.map((p) => (
            <div key={p.id} className="perm-card">
              <div className="perm-title">
                <span className="tool-dot" style={{ background: toolColor(p.tool) }} />
                {p.label ?? p.session_id} — {p.tool_name}
              </div>
              <div className="perm-desc">{p.description}</div>
              <div className="perm-actions">
                <button className="deny" onClick={() => respond(p.id, "deny")}>
                  拒否
                </button>
                <button className="allow" onClick={() => respond(p.id, "allow")}>
                  許可
                </button>
              </div>
            </div>
          ))}

          {usageAlerts.map((a) => (
            <div key={`${a.tool}:${a.label}`} className="usage-alert">
              <span className="tool-dot" style={{ background: toolColor(a.tool) }} />
              <span className="usage-alert-text">
                {TOOL_LABELS[a.tool] ?? a.tool} の{a.label}枠が{Math.round(a.utilization)}%です
              </span>
              <button
                className="usage-alert-close"
                onClick={() =>
                  setUsageAlerts((prev) =>
                    prev.filter((x) => !(x.tool === a.tool && x.label === a.label)),
                  )
                }
              >
                ✕
              </button>
            </div>
          ))}

          {sessions.length === 0 && permissions.length === 0 && (
            <div className="empty">エージェントは動いていません</div>
          )}

          {sessions.map((s) => (
            <div key={s.session_id} className={`session-block ${isFinished(s.status) ? "past" : ""}`}>
              <div
                className="session-row"
                title={s.terminal?.window_title ?? undefined}
                onClick={() => jump(s.terminal?.pid)}
              >
                <span
                  className={`tool-dot ${isFinished(s.status) ? "finished" : ""}`}
                  style={{ background: toolColor(s.tool) }}
                />
                <div className="session-main">
                  <div className="session-label">{s.label ?? s.session_id}</div>
                  <div className="session-message">{s.message ?? statusLabel(s.status)}</div>
                </div>
                <div className="session-meta">
                  {isStalled(s, settings?.stall_after_minutes ?? 0) ? (
                    <span className="status-pill status-stalled" title="長時間更新がありません">
                      停滞
                    </span>
                  ) : (
                    <span className={`status-pill status-${s.status}`}>{statusLabel(s.status)}</span>
                  )}
                  <span className="elapsed">{elapsed(s.updated_at)}</span>
                </div>
              </div>

              {s.question && (
                <div className="question-card" onClick={() => jump(s.terminal?.pid)}>
                  <div className="question-text">{s.question.text}</div>
                  <div className="question-options">
                    {s.question.options.map((opt, i) => (
                      <span key={i} className="question-option">
                        <span className="question-option-num">{i + 1}</span>
                        {opt}
                      </span>
                    ))}
                  </div>
                  <div className="question-hint">クリックでターミナルへ移動して回答</div>
                </div>
              )}
            </div>
          ))}

          {usage.length > 0 && (
            <div className="usage-footer">
              {usage.map((u) => (
                <div key={u.tool} className="usage-group">
                  <div className="usage-tool">
                    <span className="tool-dot" style={{ background: toolColor(u.tool) }} />
                    {TOOL_LABELS[u.tool] ?? u.tool}
                    {u.plan && <span className="usage-plan">{u.plan}</span>}
                  </div>
                  {u.windows.map((win) => (
                    <div
                      key={win.label}
                      className={`usage-row severity-${usageSeverity(win.utilization)}`}
                    >
                      <span className="usage-label">{win.label}</span>
                      <div className="usage-bar">
                        <div
                          className="usage-bar-fill"
                          style={{ width: `${Math.min(100, win.utilization)}%` }}
                        />
                      </div>
                      <span className="usage-percent">{Math.round(win.utilization)}%</span>
                      <span className="usage-reset">{countdown(win.resets_at_ms)}リセット</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="controls">
            <button
              className={`control-toggle ${approvalMode ? "on" : ""} ${confirmApproval ? "pending" : ""}`}
              onClick={onApprovalButton}
              title="ONにすると全ツール実行前にここで承認が必要になります"
            >
              承認モード {approvalMode ? "ON" : "OFF"}
            </button>
            {confirmApproval && !approvalMode && (
              <button className="control-toggle confirm" onClick={() => applyApprovalMode(true)}>
                ONにする
              </button>
            )}
            <button className="control-toggle" onClick={toggleMute} title="サウンド通知">
              {muted ? "🔇" : "🔊"}
            </button>
            <button
              className={`control-toggle ${showSettings ? "on" : ""}`}
              onClick={() => setShowSettings((v) => !v)}
              title="設定"
            >
              ⚙
            </button>
          </div>

          {showSettings && settings && (
            <div className="settings-panel">
              <label className="setting-row">
                <span className="setting-label">幅</span>
                <input
                  type="range"
                  min={280}
                  max={720}
                  step={10}
                  value={settings.width}
                  onChange={(e) => updateSettings({ width: Number(e.target.value) })}
                />
                <span className="setting-value">{settings.width}px</span>
              </label>

              <div className="setting-row">
                <span className="setting-label">位置</span>
                <div className="setting-segments">
                  {(
                    [
                      ["left", "左"],
                      ["center", "中央"],
                      ["right", "右"],
                    ] as const
                  ).map(([value, text]) => (
                    <button
                      key={value}
                      className={`segment ${settings.anchor === value ? "on" : ""}`}
                      onClick={() => updateSettings({ anchor: value })}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>

              <label className="setting-row">
                <span className="setting-label">上余白</span>
                <input
                  type="range"
                  min={0}
                  max={120}
                  step={2}
                  value={settings.top_offset}
                  onChange={(e) => updateSettings({ top_offset: Number(e.target.value) })}
                />
                <span className="setting-value">{settings.top_offset}px</span>
              </label>

              {monitors.length > 1 && (
                <label className="setting-row">
                  <span className="setting-label">画面</span>
                  <select
                    className="setting-select"
                    value={settings.monitor}
                    onChange={(e) => updateSettings({ monitor: e.target.value })}
                  >
                    <option value="">メイン画面</option>
                    {monitors.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="setting-row">
                <span className="setting-label">ホットキー</span>
                <select
                  className="setting-select"
                  value={settings.hotkey}
                  onChange={(e) => updateSettings({ hotkey: e.target.value })}
                >
                  {HOTKEY_CHOICES.map((k) => (
                    <option key={k || "none"} value={k}>
                      {k || "なし"}
                    </option>
                  ))}
                </select>
              </label>

              <label className="setting-row">
                <span className="setting-label">停滞警告</span>
                <input
                  type="range"
                  min={0}
                  max={60}
                  step={5}
                  value={settings.stall_after_minutes}
                  onChange={(e) => updateSettings({ stall_after_minutes: Number(e.target.value) })}
                />
                <span className="setting-value">
                  {settings.stall_after_minutes === 0 ? "なし" : `${settings.stall_after_minutes}分`}
                </span>
              </label>

              <label className="setting-row checkbox">
                <input
                  type="checkbox"
                  checked={settings.collapse_on_leave}
                  onChange={(e) => updateSettings({ collapse_on_leave: e.target.checked })}
                />
                <span className="setting-label">マウスが離れたら折りたたむ</span>
              </label>

              <label className="setting-row checkbox">
                <input type="checkbox" checked={autostart} onChange={toggleAutostart} />
                <span className="setting-label">Windows起動時に自動で起動する</span>
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
