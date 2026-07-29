#!/usr/bin/env node
// Roost — Claude Code approval bridge (PreToolUse).
//
// When approval mode is OFF (the default) this exits immediately with no
// output, deferring to Claude Code's own permission flow — that fast path must
// stay free of network calls and subprocesses since it runs before every single
// tool call.
//
// When ON, it blocks on the overlay's /permission endpoint and translates the
// user's click into a PreToolUse permission decision.

import {
  approvalModeEnabled,
  describeTool,
  labelFor,
  parseJson,
  readStdin,
  requestPermission,
} from "./lib/bridge.mjs";
import { s } from "./lib/strings.mjs";

function decide(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function main() {
  if (!approvalModeEnabled()) return;

  const payload = parseJson(readStdin());
  const sessionId = payload.session_id || `unknown-${process.ppid}`;
  const toolName = payload.tool_name || s("tool");

  const decision = await requestPermission({
    session_id: sessionId,
    tool: "claude",
    label: labelFor(payload.cwd, sessionId),
    tool_name: toolName,
    description: describeTool(toolName, payload.tool_input),
  });

  // Anything other than a real answer falls back to Claude Code's own prompt.
  // Silently allowing would make approval mode a no-op exactly when the user
  // believes it is protecting them.
  if (decision === "allow") decide("allow", s("approved"));
  else if (decision === "deny") decide("deny", s("denied"));
  else decide("ask", s("unreachable"));
}

main();
