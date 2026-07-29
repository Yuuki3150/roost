#!/usr/bin/env node
// Roost — Claude Code AskUserQuestion display bridge.
//
// Registered as a PreToolUse hook with matcher "AskUserQuestion". Mirrors the
// question and its options into the overlay so they're visible without leaving
// the editor. Answering still happens in the terminal — the overlay row is a
// click-to-jump shortcut, not an input surface.
//
// Fire-and-forget: emits no hook output and never blocks the tool call.

import {
  labelFor,
  parseJson,
  postEvent,
  readStdin,
  terminalForSession,
  truncate,
} from "./lib/bridge.mjs";
import { s } from "./lib/strings.mjs";

function firstQuestion(toolInput) {
  const q = toolInput?.questions?.[0];
  if (!q || typeof q.question !== "string") return null;
  return {
    header: typeof q.header === "string" ? q.header : null,
    text: truncate(q.question, 120),
    options: Array.isArray(q.options)
      ? q.options
          .map((o) => (typeof o?.label === "string" ? truncate(o.label, 40) : null))
          .filter(Boolean)
      : [],
  };
}

function main() {
  const payload = parseJson(readStdin());
  const question = firstQuestion(payload.tool_input);
  if (!question) return;

  const sessionId = payload.session_id || `unknown-${process.ppid}`;
  postEvent({
    session_id: sessionId,
    tool: "claude",
    label: labelFor(payload.cwd, sessionId),
    status: "waiting_input",
    message: question.header ?? s("question"),
    terminal: terminalForSession(sessionId),
    question,
  });
}

main();
