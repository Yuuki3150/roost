#!/usr/bin/env node
// Roost — one-shot hook installer.
//
// Each supported agent stores its hook config somewhere different and in a
// slightly different shape, and every entry needs an absolute path to a script
// in *this* checkout. Doing that by hand means editing three JSON files and
// getting the escaping right, so this does it instead.
//
//   node scripts/setup.mjs            install for every agent found
//   node scripts/setup.mjs --dry-run  show what would change
//   node scripts/setup.mjs --remove   take the hooks back out
//
// Existing config is preserved: only Roost's own entries are added or removed,
// and the original file is backed up next to it before the first write.

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const SCRIPTS = path.resolve(import.meta.dirname);
const DRY_RUN = process.argv.includes("--dry-run");
const REMOVE = process.argv.includes("--remove");

/// Marks the entries we own so --remove can find them again without touching
/// hooks the user added themselves.
const TAG = "roost";

function hookCommand(script, ...args) {
  // Quote for the shell, but keep the path's own backslashes single. Escaping
  // them here would double up again when the config is serialised to JSON and
  // the agent would end up invoking a path that doesn't exist.
  const full = path.join(SCRIPTS, script);
  return [`node "${full}"`, ...args].join(" ");
}

function isOurs(command) {
  return typeof command === "string" && command.includes(SCRIPTS);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  if (DRY_RUN) return;
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file) && !existsSync(`${file}.roost-backup`)) {
    copyFileSync(file, `${file}.roost-backup`);
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// --------------------------------------------------------------- Claude ----

function claudeEntries() {
  const wrap = (command, extra = {}) => ({
    hooks: [{ type: "command", command, shell: "bash", ...extra }],
  });
  return {
    SessionStart: [wrap(hookCommand("hook.mjs", "SessionStart"))],
    UserPromptSubmit: [wrap(hookCommand("hook.mjs", "UserPromptSubmit"))],
    PreToolUse: [
      wrap(hookCommand("hook.mjs", "PreToolUse")),
      {
        matcher: "AskUserQuestion",
        hooks: [{ type: "command", command: hookCommand("hook-question.mjs"), shell: "bash" }],
      },
      // Must outlast the app's own 300s wait, or the hook is killed mid-prompt.
      wrap(hookCommand("hook-permission.mjs"), { timeout: 310 }),
    ],
    Notification: [wrap(hookCommand("hook.mjs", "Notification"))],
    Stop: [wrap(hookCommand("hook.mjs", "Stop"))],
    SessionEnd: [wrap(hookCommand("hook.mjs", "SessionEnd"))],
  };
}

function installClaude() {
  const file = path.join(os.homedir(), ".claude", "settings.json");
  const config = readJson(file) ?? {};
  config.hooks ??= {};

  for (const [event, entries] of Object.entries(claudeEntries())) {
    const kept = (config.hooks[event] ?? []).filter(
      (entry) => !(entry.hooks ?? []).some((h) => isOurs(h.command)),
    );
    config.hooks[event] = REMOVE ? kept : [...kept, ...entries];
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  writeJson(file, config);
  return file;
}

// ---------------------------------------------------------------- Cursor ----

function cursorEntries() {
  const status = (event) => ({ command: hookCommand("hook-cursor.mjs", "status", event) });
  return {
    sessionStart: [status("sessionStart")],
    beforeSubmitPrompt: [status("beforeSubmitPrompt")],
    preToolUse: [status("preToolUse")],
    beforeShellExecution: [
      status("beforeShellExecution"),
      { command: hookCommand("hook-cursor.mjs", "approve"), timeout: 310 },
    ],
    stop: [status("stop")],
    sessionEnd: [status("sessionEnd")],
  };
}

function installCursor() {
  const file = path.join(os.homedir(), ".cursor", "hooks.json");
  const config = readJson(file) ?? { version: 1, hooks: {} };
  config.version ??= 1;
  config.hooks ??= {};

  for (const [event, entries] of Object.entries(cursorEntries())) {
    const kept = (config.hooks[event] ?? []).filter((entry) => !isOurs(entry.command));
    config.hooks[event] = REMOVE ? kept : [...kept, ...entries];
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  writeJson(file, config);
  return file;
}

// ---------------------------------------------------------------- Gemini ----

function geminiEntries() {
  const status = (event) => ({
    hooks: [{ type: "command", command: hookCommand("hook-gemini.mjs", "status", event) }],
  });
  return {
    SessionStart: [status("SessionStart")],
    BeforeAgent: [status("BeforeAgent")],
    BeforeTool: [
      status("BeforeTool"),
      // Gemini's timeout is documented in milliseconds.
      { hooks: [{ type: "command", command: hookCommand("hook-gemini.mjs", "approve"), timeout: 310000 }] },
    ],
    Notification: [status("Notification")],
    AfterAgent: [status("AfterAgent")],
    SessionEnd: [status("SessionEnd")],
  };
}

function installGemini() {
  const file = path.join(os.homedir(), ".gemini", "settings.json");
  const config = readJson(file) ?? {};
  config.hooks ??= {};

  for (const [event, entries] of Object.entries(geminiEntries())) {
    const kept = (config.hooks[event] ?? []).filter(
      (entry) => !(entry.hooks ?? []).some((h) => isOurs(h.command)),
    );
    config.hooks[event] = REMOVE ? kept : [...kept, ...entries];
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  writeJson(file, config);
  return file;
}

// ----------------------------------------------------------------- Codex ----

/// Codex takes a single notify program in TOML rather than a JSON hook list.
/// Rewriting TOML safely is more than this script should attempt, so it prints
/// the line to paste instead.
function codexInstructions() {
  const file = path.join(os.homedir(), ".codex", "config.toml");
  if (!existsSync(file)) return null;
  // A TOML literal string (single quotes) takes the Windows path verbatim —
  // no backslash escaping to get wrong.
  const script = path.join(SCRIPTS, "hook-codex.mjs");
  return { file, line: `notify = [ "node", '${script}' ]` };
}

// ------------------------------------------------------------------ main ----

const AGENTS = [
  { name: "Claude Code", dir: ".claude", install: installClaude },
  { name: "Cursor", dir: ".cursor", install: installCursor },
  { name: "Gemini CLI", dir: ".gemini", install: installGemini },
];

function main() {
  const verb = REMOVE ? "Removing" : "Installing";
  console.log(`${verb} Roost hooks${DRY_RUN ? " (dry run)" : ""}\n  scripts: ${SCRIPTS}\n`);

  let touched = 0;
  for (const agent of AGENTS) {
    const configured = existsSync(path.join(os.homedir(), agent.dir));
    // Removal must reach configs even if the agent's directory is gone.
    if (!configured && !REMOVE) {
      console.log(`  -  ${agent.name}: not installed, skipped`);
      continue;
    }
    const file = agent.install();
    touched++;
    console.log(`  ${REMOVE ? "x" : "+"}  ${agent.name}: ${file}`);
  }

  const codex = codexInstructions();
  if (codex && !REMOVE) {
    console.log(`\n  Codex CLI needs one manual line in ${codex.file}:\n    ${codex.line}`);
    console.log("  (If a notify program is already set, Codex chains this one via --previous-notify.)");
  }

  if (DRY_RUN) {
    console.log("\nDry run: nothing was written.");
  } else if (touched > 0) {
    console.log(`\nDone. Originals were backed up as *.roost-backup.`);
    console.log("Restart the agent (or reopen Cursor) to pick the hooks up.");
  }
}

main();
