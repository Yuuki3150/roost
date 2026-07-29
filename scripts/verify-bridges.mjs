// Exercises every bridge script against a stub overlay server, using payloads
// shaped like each vendor documents them. Cursor and Gemini aren't installed
// here, so this is what stands in for an end-to-end test of those two.
//
// Run:  node scripts/verify-bridges.mjs
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";

const REPO = path.resolve(import.meta.dirname, "..");
const STATE = path.join(os.homedir(), "AppData", "Local", "Roost");
const PORT_FILE = path.join(STATE, "port.txt");
const APPROVAL = path.join(STATE, "approval-mode.json");

// These tests hijack the real state files, so they must run whether or not
// Roost has ever been started. `null` means "didn't exist" and is restored by
// deleting rather than writing an empty file back.
mkdirSync(STATE, { recursive: true });
const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const restore = (file, saved) => {
  if (saved === null) rmSync(file, { force: true });
  else writeFileSync(file, saved);
};

const savedPort = read(PORT_FILE);
const savedApproval = read(APPROVAL);

const received = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    received.push({ path: req.url, body: JSON.parse(raw || "{}") });
    res.writeHead(200, { "Content-Type": "application/json" });
    // Approval probes answer "allow" so the blocking path completes.
    res.end(req.url === "/permission" ? '{"decision":"allow"}' : '{"ok":true}');
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
writeFileSync(PORT_FILE, String(server.address().port));

function run(args, { stdin, argv2 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", argv2 ? [...args, argv2] : args, { cwd: REPO });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    const kill = setTimeout(() => child.kill(), 15_000);
    child.on("close", () => {
      clearTimeout(kill);
      resolve(stdout);
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

const CURSOR_BASE = {
  conversation_id: "conv-abc",
  generation_id: "gen-1",
  workspace_roots: ["C:\\work\\demo"],
  cursor_version: "1.7.0",
};

const GEMINI_BASE = {
  session_id: "sess-xyz",
  cwd: "C:\\work\\demo",
  transcript_path: null,
};

const CASES = [
  {
    name: "cursor sessionStart",
    args: ["scripts/hook-cursor.mjs", "status", "sessionStart"],
    stdin: JSON.stringify({ ...CURSOR_BASE, hook_event_name: "sessionStart" }),
    expect: (e) => e.tool === "cursor" && e.status === "running" && e.label === "demo",
  },
  {
    name: "cursor beforeSubmitPrompt",
    args: ["scripts/hook-cursor.mjs", "status", "beforeSubmitPrompt"],
    stdin: JSON.stringify({ ...CURSOR_BASE, prompt: "add a login page" }),
    expect: (e) => e.status === "running" && e.message.includes("add a login page"),
  },
  {
    name: "cursor preToolUse",
    args: ["scripts/hook-cursor.mjs", "status", "preToolUse"],
    stdin: JSON.stringify({ ...CURSOR_BASE, tool_name: "Write", tool_input: { path: "a.ts" } }),
    expect: (e) => e.message.includes("Write"),
  },
  {
    name: "cursor stop",
    args: ["scripts/hook-cursor.mjs", "status", "stop"],
    stdin: JSON.stringify({ ...CURSOR_BASE, status: "completed", loop_count: 1 }),
    expect: (e) => e.status === "done",
  },
  {
    name: "cursor sessionEnd",
    args: ["scripts/hook-cursor.mjs", "status", "sessionEnd"],
    stdin: JSON.stringify({ ...CURSOR_BASE, reason: "user_close" }),
    expect: (e) => e.status === "closed",
  },
  {
    name: "gemini SessionStart",
    args: ["scripts/hook-gemini.mjs", "status", "SessionStart"],
    stdin: JSON.stringify({ ...GEMINI_BASE, hook_event_name: "SessionStart" }),
    expect: (e) => e.tool === "gemini" && e.status === "running" && e.label === "demo",
  },
  {
    name: "gemini BeforeTool",
    args: ["scripts/hook-gemini.mjs", "status", "BeforeTool"],
    stdin: JSON.stringify({ ...GEMINI_BASE, tool_name: "run_shell_command", tool_input: { command: "ls" } }),
    expect: (e) => e.message.includes("run_shell_command"),
  },
  {
    name: "gemini Notification",
    args: ["scripts/hook-gemini.mjs", "status", "Notification"],
    stdin: JSON.stringify({ ...GEMINI_BASE, message: "Waiting for tool approval" }),
    expect: (e) => e.status === "waiting_input",
  },
  {
    name: "gemini AfterAgent",
    args: ["scripts/hook-gemini.mjs", "status", "AfterAgent"],
    stdin: JSON.stringify({ ...GEMINI_BASE }),
    expect: (e) => e.status === "done",
  },
  {
    name: "claude PreToolUse (regression)",
    args: ["scripts/hook.mjs", "PreToolUse"],
    stdin: JSON.stringify({ session_id: "s1", cwd: "C:\\x\\demo", tool_name: "Bash" }),
    expect: (e) => e.tool === "claude" && e.message.includes("Bash"),
  },
  {
    name: "codex turn complete (regression)",
    args: ["scripts/hook-codex.mjs"],
    argv2: JSON.stringify({
      type: "agent-turn-complete",
      "conversation-id": "c1",
      cwd: "C:\\x\\demo",
      "last-assistant-message": "done",
    }),
    expect: (e) => e.tool === "codex" && e.status === "waiting_input",
  },
];

let failures = 0;
try {
  // --- status events -------------------------------------------------------
  writeFileSync(APPROVAL, JSON.stringify({ enabled: false, updated_at: 0 }));
  for (const c of CASES) {
    received.length = 0;
    await run(c.args, { stdin: c.stdin, argv2: c.argv2 });
    await new Promise((r) => setTimeout(r, 250));
    const event = received.find((r) => r.path === "/event")?.body;
    const ok = event ? c.expect(event) : false;
    if (!ok) failures++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${c.name}${ok ? "" : `  got=${JSON.stringify(event)}`}`,
    );
  }

  // --- approval OFF must stay silent --------------------------------------
  for (const [name, args] of [
    ["cursor approve (mode off)", ["scripts/hook-cursor.mjs", "approve"]],
    ["gemini approve (mode off)", ["scripts/hook-gemini.mjs", "approve"]],
  ]) {
    const out = await run(args, { stdin: JSON.stringify({ ...CURSOR_BASE, command: "ls" }) });
    const ok = out === "";
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: expected no output, got ${JSON.stringify(out)}`);
  }

  // --- approval ON must emit each vendor's own allow shape -----------------
  writeFileSync(APPROVAL, JSON.stringify({ enabled: true, updated_at: 0 }));
  const cursorOut = await run(["scripts/hook-cursor.mjs", "approve"], {
    stdin: JSON.stringify({ ...CURSOR_BASE, command: "npm test" }),
  });
  const cursorOk = JSON.parse(cursorOut || "{}").permission === "allow";
  if (!cursorOk) failures++;
  console.log(`${cursorOk ? "PASS" : "FAIL"}  cursor approve (mode on): got ${cursorOut}`);

  const geminiOut = await run(["scripts/hook-gemini.mjs", "approve"], {
    stdin: JSON.stringify({ ...GEMINI_BASE, tool_name: "run_shell_command" }),
  });
  const geminiOk = JSON.parse(geminiOut || "{}").decision === "allow";
  if (!geminiOk) failures++;
  console.log(`${geminiOk ? "PASS" : "FAIL"}  gemini approve (mode on): got ${geminiOut}`);
} finally {
  server.close();
  restore(PORT_FILE, savedPort);
  restore(APPROVAL, savedApproval);
  console.log("\nrestored port.txt and approval-mode.json");
}
process.exit(failures ? 1 : 0);
