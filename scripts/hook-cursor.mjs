#!/usr/bin/env node
// Roost — Cursor hooks bridge.
//
// Registered in ~/.cursor/hooks.json (user scope) or .cursor/hooks.json
// (project scope). Cursor passes the event payload as JSON on stdin and reads
// JSON back on stdout; the event name comes from argv so one script can serve
// every hook.
//
//   node hook-cursor.mjs status <event>   → fire-and-forget status update
//   node hook-cursor.mjs approve          → blocking approval for shell commands
//
// Cursor treats a non-zero exit as "fail open" unless the hook sets
// failClosed, so exiting 0 with no output is always the safe no-op.

import {
  approvalModeEnabled,
  labelFor,
  parseJson,
  postEvent,
  readStdin,
  requestPermission,
  terminalForSession,
  truncate,
} from "./lib/bridge.mjs";

const MODE = process.argv[2] || "status";
const EVENT = process.argv[3] || "";

/// Cursor's payload keys aren't fully documented and have shifted between
/// releases, so accept the plausible spellings rather than betting on one.
function pick(payload, ...keys) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function sessionOf(payload) {
  return (
    pick(payload, "conversation_id", "conversationId", "session_id", "sessionId", "chat_id") ??
    `cursor-${process.ppid}`
  );
}

function workspaceOf(payload) {
  const roots = payload.workspace_roots ?? payload.workspaceRoots;
  if (Array.isArray(roots) && typeof roots[0] === "string") return roots[0];
  return pick(payload, "workspace_root", "workspaceRoot", "cwd");
}

function baseFor(payload) {
  const sessionId = sessionOf(payload);
  const key = `cursor-${sessionId}`;
  return {
    session_id: key,
    tool: "cursor",
    label: labelFor(workspaceOf(payload), sessionId),
    terminal: terminalForSession(key),
  };
}

function runStatus(payload) {
  const base = baseFor(payload);
  switch (EVENT) {
    case "sessionStart":
      postEvent({ ...base, status: "running", message: "セッション開始" });
      break;
    case "beforeSubmitPrompt":
      postEvent({
        ...base,
        status: "running",
        message: truncate(pick(payload, "prompt", "text"), 60) || "考え中…",
      });
      break;
    case "preToolUse":
      postEvent({
        ...base,
        status: "running",
        message: `${pick(payload, "tool_name", "toolName", "tool") ?? "ツール"} を実行中`,
      });
      break;
    case "beforeShellExecution":
      postEvent({
        ...base,
        status: "running",
        message: truncate(pick(payload, "command"), 60) || "コマンド実行中",
      });
      break;
    case "stop":
      postEvent({ ...base, status: "done", message: "完了" });
      break;
    case "sessionEnd":
      postEvent({ ...base, status: "closed", message: "終了" });
      break;
    default:
      break;
  }
}

async function runApprove(payload) {
  // Off by default: stay silent so Cursor keeps its own behaviour untouched.
  if (!approvalModeEnabled()) return;

  const command = pick(payload, "command") ?? "";
  const base = baseFor(payload);
  const decision = await requestPermission({
    session_id: base.session_id,
    tool: "cursor",
    label: base.label,
    tool_name: pick(payload, "tool_name", "toolName") ?? "Shell",
    description: command || "コマンド実行",
  });

  // Only a real answer decides. Anything else defers to Cursor's own prompt —
  // turning a transport error into a denial would block work the user never saw.
  if (decision === "allow") {
    process.stdout.write(JSON.stringify({ permission: "allow" }));
  } else if (decision === "deny") {
    process.stdout.write(
      JSON.stringify({
        permission: "deny",
        user_message: "Roost で拒否しました",
        agent_message: "The user denied this command from Roost.",
      }),
    );
  } else {
    process.stdout.write(
      JSON.stringify({
        permission: "ask",
        user_message: "Roost に接続できなかったため、こちらで確認してください",
      }),
    );
  }
}

async function main() {
  const payload = parseJson(readStdin());
  if (MODE === "approve") await runApprove(payload);
  else runStatus(payload);
}

main();
