// Shared plumbing for every agent bridge script.
//
// Each supported CLI has its own hook/notify mechanism, but they all end up
// doing the same three things: find the overlay's port, describe which terminal
// (or editor window) the session belongs to, and POST a status update. Keeping
// that here means adding a new agent is just a small adapter.
//
// Everything is fail-quiet by design: a bridge must never break the agent it is
// observing, so errors are swallowed and calls time out fast.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import os from "node:os";

const STATE_DIR = path.join(os.homedir(), "AppData", "Local", "Roost");
const PORT_FILE = path.join(STATE_DIR, "port.txt");
const APPROVAL_FILE = path.join(STATE_DIR, "approval-mode.json");
const CACHE_DIR = path.join(STATE_DIR, "sessions");

const EVENT_TIMEOUT_MS = 800;
/// Must exceed the server's own 300s wait so we receive its default-deny
/// answer rather than tearing the socket down first.
export const PERMISSION_TIMEOUT_MS = 305_000;

/// Processes that own a window worth jumping back to. Terminals for CLI agents,
/// plus editors that host an agent directly.
const HOST_PROCESSES = new Set([
  "WindowsTerminal.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "ConEmu64.exe",
  "ConEmu.exe",
  "wezterm-gui.exe",
  "alacritty.exe",
  "mintty.exe",
  "Cursor.exe",
  "Code.exe",
]);

export function getPort() {
  try {
    return parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10) || null;
  } catch {
    return null;
  }
}

export function approvalModeEnabled() {
  try {
    return JSON.parse(readFileSync(APPROVAL_FILE, "utf8")).enabled === true;
  } catch {
    return false;
  }
}

export function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function parseJson(raw, fallback = {}) {
  try {
    return JSON.parse(raw || "") ?? fallback;
  } catch {
    return fallback;
  }
}

export function truncate(text, n) {
  if (!text) return text;
  const t = String(text).trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/// Short, recognisable name for a session — the working directory basename is
/// far more useful at a glance than a session UUID.
export function labelFor(cwd, sessionId) {
  if (cwd) return path.basename(cwd);
  return String(sessionId ?? "").slice(0, 8) || "session";
}

function resolveHostPid(startPid) {
  let pid = startPid;
  for (let i = 0; i < 8; i++) {
    let info;
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\" | Select-Object Name,ParentProcessId | ConvertTo-Json -Compress"`,
        { encoding: "utf8", timeout: 2000, windowsHide: true },
      );
      info = JSON.parse(out);
    } catch {
      break;
    }
    if (!info || !info.Name) break;
    if (HOST_PROCESSES.has(info.Name)) return pid;
    if (!info.ParentProcessId || info.ParentProcessId === pid) break;
    pid = info.ParentProcessId;
  }
  return startPid;
}

/// Walking the process tree costs a PowerShell round-trip, so the answer is
/// cached per session and reused by every later event for that session.
export function terminalForSession(cacheKey) {
  const file = path.join(CACHE_DIR, `${cacheKey}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // not cached yet — resolve below
  }
  const terminal = { app: null, pid: resolveHostPid(process.ppid), window_title: null };
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(terminal));
  } catch {
    // best-effort cache only
  }
  return terminal;
}

/// Fire-and-forget status update. Never blocks the agent.
export function postEvent(body) {
  const port = getPort();
  if (!port) return;
  const data = JSON.stringify(body);
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/event",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: EVENT_TIMEOUT_MS,
    },
    (res) => res.resume(),
  );
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
  req.write(data);
  req.end();
}

/// Blocks until the user answers in the overlay.
/// Resolves to "allow" | "deny", or null when we got anything other than a real
/// answer. Callers must treat null as "no decision" and fall back to the
/// agent's own prompt — turning a transport error into a denial would silently
/// block tool calls the user never saw.
export function requestPermission(body) {
  return new Promise((resolve) => {
    const port = getPort();
    if (!port) return resolve(null);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/permission",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        timeout: PERMISSION_TIMEOUT_MS,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const decision = parseJson(raw, {}).decision;
          resolve(decision === "allow" || decision === "deny" ? decision : null);
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

/// Best-effort description of what a tool call is about to do, for the
/// approval card.
export function describeTool(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return toolName;
  for (const key of ["command", "file_path", "path", "url"]) {
    if (typeof toolInput[key] === "string") return toolInput[key];
  }
  return toolName;
}
