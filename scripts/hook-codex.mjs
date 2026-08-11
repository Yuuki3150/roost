#!/usr/bin/env node
// Roost — Codex CLI notify bridge.
//
// Codex's `notify` config runs one program and appends a single JSON string as
// the last argument (not stdin). It only fires on turn boundaries, so the
// granularity here is "finished", not per-tool-call.
//
// Codex chains a previously configured notify target itself via
// `--previous-notify`, so this script does not need to forward anything.

import { labelFor, parseJson, postEvent, terminalRef, truncate } from "./lib/bridge.mjs";
import { s } from "./lib/strings.mjs";

function isBackgroundTask(payload) {
  if (payload.background === true || payload.is_background === true || payload["is-background"] === true) {
    return true;
  }
  return [
    payload.type,
    payload.task_type,
    payload["task-type"],
    payload.task_kind,
    payload.thread_source,
    payload["thread-source"],
    payload.mode,
  ]
    .filter((value) => typeof value === "string")
    .some((value) => value.toLowerCase().includes("background"));
}

function main() {
  const payload = parseJson(process.argv[2]);
  if (!payload.type) return;

  // A turn ID is deliberately not a fallback here: it changes after every
  // turn, which made one Codex conversation appear as a new Roost row each
  // time. Codex's notify payload calls its stable chat identifier `thread-id`
  // (some versions use a conversation/session alias), so prefer every stable
  // form before falling back to a process-local ID.
  const sessionId =
    payload["thread-id"] ||
    payload.thread_id ||
    payload["conversation-id"] ||
    payload.conversation_id ||
    payload.session_id ||
    `pid-${process.ppid}`;
  const cwd = payload.cwd || payload.cwd_path;

  const base = {
    session_id: `codex-${sessionId}`,
    tool: "codex",
    label: labelFor(cwd, sessionId),
    is_background: isBackgroundTask(payload),
    terminal: terminalRef(),
  };

  if (payload.type === "agent-turn-complete") {
    postEvent({
      ...base,
      // This is emitted after Codex has completed its turn. It does not mean
      // Codex is asking the user a question, so showing "waiting" here is
      // misleading and also keeps the row in the attention state.
      status: "done",
      message: truncate(payload["last-assistant-message"], 80) || s("done"),
    });
  } else {
    postEvent({ ...base, status: "running", message: truncate(payload.type, 60) });
  }
}

main();
