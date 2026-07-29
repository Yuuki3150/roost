// Status text the bridges send to the overlay. English by default, Japanese
// when Windows is set to Japanese — matching what the UI itself picks.

import { execSync } from "node:child_process";

/// Explicit settings win — and must be able to select *either* language, not
/// just switch Japanese on. Falls back to the OS UI language, which is the only
/// signal normally present on Windows.
function detectJapanese() {
  const explicit = process.env.ROOST_LANG ?? process.env.LC_ALL ?? process.env.LANG;
  if (explicit) return explicit.toLowerCase().startsWith("ja");
  try {
    const out = execSync('powershell -NoProfile -Command "(Get-UICulture).Name"', {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    return out.trim().toLowerCase().startsWith("ja");
  } catch {
    return false;
  }
}

// Resolved lazily and cached: the fallback costs a subprocess, and hooks that
// never emit a string shouldn't pay for it.
let cached = null;
function isJa() {
  if (cached === null) cached = detectJapanese();
  return cached;
}

const STRINGS = {
  sessionStart: ["Session started", "セッション開始"],
  thinking: ["Thinking…", "考え中…"],
  runningTool: [(tool) => `Running ${tool}`, (tool) => `${tool} を実行中`],
  runningCommand: ["Running a command", "コマンド実行中"],
  command: ["Command", "コマンド実行"],
  tool: ["a tool", "ツール"],
  waiting: ["Waiting for you", "確認待ち"],
  done: ["Done", "完了"],
  ended: ["Ended", "終了"],
  question: ["Question", "質問"],

  approved: ["Approved in Roost", "Roost で承認"],
  denied: ["Denied in Roost", "Roost で拒否"],
  unreachable: ["Roost was unreachable", "Roost に接続できませんでした"],
  unreachableAsk: [
    "Roost was unreachable — please confirm here",
    "Roost に接続できなかったため、こちらで確認してください",
  ],
  deniedByUser: [
    "The user denied this command from Roost.",
    "The user denied this command from Roost.",
  ],
};

export function s(key, ...args) {
  const value = STRINGS[key][isJa() ? 1 : 0];
  return typeof value === "function" ? value(...args) : value;
}
