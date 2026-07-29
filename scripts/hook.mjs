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
  terminalRef,
  truncate,
} from "./lib/bridge.mjs";
import { s } from "./lib/strings.mjs";

const EVENT = process.argv[2] || "unknown";

function main() {
  const payload = parseJson(readStdin());
  const sessionId = payload.session_id || `unknown-${process.ppid}`;

  const base = {
    session_id: sessionId,
    tool: "claude",
    label: labelFor(payload.cwd, sessionId),
    terminal: terminalRef(),
  };

  switch (EVENT) {
    case "SessionStart":
      postEvent({ ...base, status: "running", message: s("sessionStart") });
      break;
    case "UserPromptSubmit":
      postEvent({
        ...base,
        status: "running",
        message: truncate(payload.prompt, 60) || s("thinking"),
      });
      break;
    case "PreToolUse":
      // hook-question.mjs owns AskUserQuestion; emitting here too would race it
      // and clobber the question payload with a plain "running" update.
      if (payload.tool_name === "AskUserQuestion") break;
      postEvent({
        ...base,
        status: "running",
        message: s("runningTool", payload.tool_name ?? s("tool")),
      });
      break;
    case "Notification":
      postEvent({
        ...base,
        status: "waiting_input",
        message: truncate(payload.message, 80) || s("waiting"),
      });
      break;
    case "Stop":
    case "SubagentStop":
      postEvent({ ...base, status: "done", message: s("done") });
      break;
    case "SessionEnd":
      postEvent({ ...base, status: "closed", message: s("ended") });
      break;
    default:
      break;
  }
}

main();
