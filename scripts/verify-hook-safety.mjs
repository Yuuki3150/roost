// Verifies the permission hook never turns a non-answer into a denial.
// Runs the real hook against a stub server that replies the way the app does
// in each failure mode, with approval mode forced on for the duration.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";

const REPO = path.resolve(import.meta.dirname, "..");
const STATE = path.join(os.homedir(), "AppData", "Local", "Roost");
const APPROVAL = path.join(STATE, "approval-mode.json");
const PORT_FILE = path.join(STATE, "port.txt");

// Must run whether or not Roost has ever been started, so a missing file is a
// valid saved state and gets restored by deleting rather than writing back.
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

const savedApproval = read(APPROVAL);
const savedPort = read(PORT_FILE);

const CASES = [
  { name: "error body (400-style)", status: 400, body: '{"error":"missing field"}', expect: "ask" },
  { name: "incomplete body (503)", status: 503, body: '{"error":"incomplete body"}', expect: "ask" },
  { name: "empty body", status: 200, body: "", expect: "ask" },
  { name: "explicit deny", status: 200, body: '{"decision":"deny"}', expect: "deny" },
  { name: "explicit allow", status: 200, body: '{"decision":"allow"}', expect: "allow" },
];

writeFileSync(APPROVAL, JSON.stringify({ enabled: true, updated_at: 0 }));

let failures = 0;
try {
  for (const c of CASES) {
    const server = http.createServer((req, res) => {
      // Respond right away; waiting on 'end' can miss the event if the body
      // was already consumed, which would hang the hook for its full timeout.
      req.resume();
      res.writeHead(c.status, { "Content-Type": "application/json" });
      res.end(c.body);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    writeFileSync(PORT_FILE, String(server.address().port));

    // Must be async: the stub server shares this event loop, so a synchronous
    // spawn would deadlock waiting for a response it can never send.
    const r = await new Promise((resolve) => {
      const child = spawn("node", ["scripts/hook-permission.mjs"], { cwd: REPO });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      const kill = setTimeout(() => child.kill(), 10_000);
      child.on("close", () => {
        clearTimeout(kill);
        resolve({ stdout, stderr });
      });
      child.stdin.end(
        JSON.stringify({ session_id: "safety", tool_name: "Bash", tool_input: { command: "ls" } }),
      );
    });
    server.close();

    let got = "(no output)";
    try {
      got = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
    } catch {
      got = `(unparseable stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(
        r.stderr.slice(0, 200),
      )})`;
    }
    const ok = got === c.expect;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}: expected ${c.expect}, got ${got}`);
  }
} finally {
  restore(APPROVAL, savedApproval);
  restore(PORT_FILE, savedPort);
  console.log("\nrestored approval-mode.json and port.txt");
}
process.exit(failures ? 1 : 0);
