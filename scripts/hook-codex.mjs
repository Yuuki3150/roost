#!/usr/bin/env node
// Roost — Codex CLI notify bridge.
//
// Codex's `notify` config runs one program and appends a single JSON string as
// the last argument (not stdin). It only fires on turn boundaries, so the
// granularity here is "finished / waiting", not per-tool-call.
//
// Codex chains a previously configured notify target itself via
// `--previous-notify`, so this script does not need to forward anything.

import { labelFor, parseJson, postEvent, terminalForSession, truncate } from "./lib/bridge.mjs";

function main() {
  const payload = parseJson(process.argv[2]);
  if (!payload.type) return;

  const sessionId =
    payload["conversation-id"] || payload["turn-id"] || payload.session_id || `codex-${process.ppid}`;
  const cwd = payload.cwd || payload.cwd_path;

  const base = {
    session_id: `codex-${sessionId}`,
    tool: "codex",
    label: labelFor(cwd, sessionId),
    terminal: terminalForSession(`codex-${sessionId}`),
  };

  if (payload.type === "agent-turn-complete") {
    postEvent({
      ...base,
      status: "waiting_input",
      message: truncate(payload["last-assistant-message"], 80) || "確認待ち",
    });
  } else {
    postEvent({ ...base, status: "running", message: truncate(payload.type, 60) });
  }
}

main();
