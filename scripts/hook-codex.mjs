#!/usr/bin/env node
// Roost — Codex CLI notify bridge.
//
// Codex's `notify` config runs one program and appends a single JSON string as
// the last argument (not stdin). It only fires on turn boundaries, so the
// granularity here is "finished / waiting", not per-tool-call.
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
  // time. Codex normally supplies a conversation ID. Older/partial notify
  // payloads don't, so keep those grouped by the long-lived Codex process
  // instead. A terminal process hosts one active Codex chat at a time.
  const sessionId =
    payload["conversation-id"] || payload.conversation_id || payload.session_id || `pid-${process.ppid}`;
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
      status: "waiting_input",
      message: truncate(payload["last-assistant-message"], 80) || s("waiting"),
    });
  } else {
    postEvent({ ...base, status: "running", message: truncate(payload.type, 60) });
  }
}

main();
