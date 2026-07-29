#!/usr/bin/env node
// Roost — Claude Code status bridge.
// Registered per hook event in .claude/settings.json; reads the hook JSON
// payload from stdin and forwards a status update to the local overlay app.
// Always exits 0 and never blocks Claude Code, even if the app isn't running.

import {
  labelFor,
  parseJson,
  postEvent,
  readStdin,
  terminalForSession,
  truncate,
} from "./lib/bridge.mjs";

const EVENT = process.argv[2] || "unknown";

function main() {
  const payload = parseJson(readStdin());
  const sessionId = payload.session_id || `unknown-${process.ppid}`;

  const base = {
    session_id: sessionId,
    tool: "claude",
    label: labelFor(payload.cwd, sessionId),
    terminal: terminalForSession(sessionId),
  };

  switch (EVENT) {
    case "SessionStart":
      postEvent({ ...base, status: "running", message: "セッション開始" });
      break;
    case "UserPromptSubmit":
      postEvent({
        ...base,
        status: "running",
        message: truncate(payload.prompt, 60) || "考え中…",
      });
      break;
    case "PreToolUse":
      // hook-question.mjs owns AskUserQuestion; emitting here too would race it
      // and clobber the question payload with a plain "running" update.
      if (payload.tool_name === "AskUserQuestion") break;
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
    case "Stop":
    case "SubagentStop":
      postEvent({ ...base, status: "done", message: "完了" });
      break;
    case "SessionEnd":
      postEvent({ ...base, status: "closed", message: "終了" });
      break;
    default:
      break;
  }
}

main();
