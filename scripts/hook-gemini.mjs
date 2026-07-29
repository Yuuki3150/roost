#!/usr/bin/env node
// Roost — Gemini CLI hooks bridge.
//
// Registered in ~/.gemini/settings.json under `hooks`. Gemini's hook contract
// is close to Claude Code's — JSON on stdin, JSON on stdout — but the event
// names and the gating field differ:
//
//   Claude  PreToolUse  → hookSpecificOutput.permissionDecision allow|deny|ask
//   Gemini  BeforeTool  → decision allow|deny|block   (no "ask")
//
// Because there is no "ask", the no-answer fallback here is to print nothing
// and exit 0, which lets Gemini run its own permission prompt.
//
//   node hook-gemini.mjs status <Event>   → fire-and-forget status update
//   node hook-gemini.mjs approve          → blocking approval for tool calls

import {
  approvalModeEnabled,
  describeTool,
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

function baseFor(payload) {
  const sessionId = payload.session_id || `gemini-${process.ppid}`;
  const key = `gemini-${sessionId}`;
  return {
    session_id: key,
    tool: "gemini",
    label: labelFor(payload.cwd, sessionId),
    terminal: terminalForSession(key),
  };
}

function runStatus(payload) {
  const base = baseFor(payload);
  switch (EVENT) {
    case "SessionStart":
      postEvent({ ...base, status: "running", message: "セッション開始" });
      break;
    case "BeforeAgent":
      postEvent({
        ...base,
        status: "running",
        message: truncate(payload.prompt, 60) || "考え中…",
      });
      break;
    case "BeforeTool":
      postEvent({
        ...base,
        status: "running",
        message: `${payload.tool_name ?? "ツール"} を実行中`,
      });
      break;
    case "Notification":
      postEvent({
        ...base,
        status: "waiting_input",
        message: truncate(payload.message, 80) || "確認待ち",
      });
      break;
    case "AfterAgent":
      postEvent({ ...base, status: "done", message: "完了" });
      break;
    case "SessionEnd":
      postEvent({ ...base, status: "closed", message: "終了" });
      break;
    default:
      break;
  }
}

async function runApprove(payload) {
  // Off by default: stay silent so Gemini keeps its own behaviour untouched.
  if (!approvalModeEnabled()) return;

  const base = baseFor(payload);
  const toolName = payload.tool_name || "ツール";
  const decision = await requestPermission({
    session_id: base.session_id,
    tool: "gemini",
    label: base.label,
    tool_name: toolName,
    description: describeTool(toolName, payload.tool_input),
  });

  if (decision === "allow") {
    process.stdout.write(JSON.stringify({ decision: "allow", reason: "Roost で承認" }));
  } else if (decision === "deny") {
    process.stdout.write(JSON.stringify({ decision: "deny", reason: "Roost で拒否" }));
  }
  // No answer → print nothing. Gemini has no "ask" decision, so staying silent
  // is what hands control back to its own prompt.
}

async function main() {
  const payload = parseJson(readStdin());
  if (MODE === "approve") await runApprove(payload);
  else runStatus(payload);
}

main();
