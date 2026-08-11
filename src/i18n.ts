// Minimal locale switch. English is the default; Japanese is used when the OS
// asks for it. Not a full i18n framework — there are ~20 strings and adding a
// dependency for that would cost more than it saves.

const JA = navigator.language?.toLowerCase().startsWith("ja") ?? false;

const STRINGS = {
  idle: ["Roost", "Roost"],
  noAgents: ["No agents running", "エージェントは動いていません"],

  running: ["running", "実行中"],
  waitingPermission: ["needs approval", "承認待ち"],
  waitingInput: ["waiting", "入力待ち"],
  done: ["done", "完了"],
  closed: ["ended", "終了"],
  error: ["error", "エラー"],
  stalled: ["stalled", "停滞"],
  stalledHint: ["No updates for a while", "長時間更新がありません"],

  allow: ["Allow", "許可"],
  deny: ["Deny", "拒否"],
  questionHint: ["Click to jump to the terminal and answer", "クリックでターミナルへ移動して回答"],

  approvalMode: ["Approval", "承認モード"],
  approvalHint: [
    "When on, every tool call waits for your approval here",
    "ONにすると全ツール実行前にここで承認が必要になります",
  ],
  turnOn: ["Turn on", "ONにする"],
  sound: ["Sound", "サウンド通知"],
  settings: ["Settings", "設定"],

  width: ["Width", "幅"],
  position: ["Position", "位置"],
  left: ["Left", "左"],
  center: ["Center", "中央"],
  right: ["Right", "右"],
  topMargin: ["Top gap", "上余白"],
  display: ["Display", "画面"],
  mainDisplay: ["Main display", "メイン画面"],
  hotkey: ["Hotkey", "ホットキー"],
  none: ["None", "なし"],
  stallAfter: ["Stall after", "停滞警告"],
  hideFinishedAfter: ["Hide finished after", "完了を隠すまで"],
  keep: ["Keep", "残す"],
  dismiss: ["Dismiss", "この行を消す"],
  clearFinished: ["Clear finished", "完了を消す"],
  minutesShort: ["m", "分"],
  collapseOnLeave: ["Collapse when the pointer leaves", "マウスが離れたら折りたたむ"],
  autostart: ["Start with Windows", "Windows起動時に自動で起動する"],

  usageAlert: [
    (tool: string, label: string, pct: number) => `${tool} ${label} usage is at ${pct}%`,
    (tool: string, label: string, pct: number) => `${tool} の${label}枠が${pct}%です`,
  ],
  resetsIn: [(when: string) => `resets in ${when}`, (when: string) => `${when}リセット`],
  soon: ["moments", "まもなく"],
  days: [(d: number, h: number) => `${d}d ${h}h`, (d: number, h: number) => `${d}日${h}時間後`],
  hours: [(h: number, m: number) => `${h}h ${m}m`, (h: number, m: number) => `${h}時間${m}分後`],
  minutes: [(m: number) => `${m}m`, (m: number) => `${m}分後`],

  fiveHour: ["5h", "5時間"],
  weekly: ["Weekly", "週次"],
} as const;

type Key = keyof typeof STRINGS;

/// Picks the Japanese or English variant of a string.
export function t<K extends Key>(key: K): (typeof STRINGS)[K][0] | (typeof STRINGS)[K][1] {
  const pair = STRINGS[key];
  return JA ? pair[1] : pair[0];
}

/// Window labels come from the backend already localised for Japanese (the
/// provider APIs don't name them), so translate the two known ones on the way
/// out and pass anything else through.
export function windowLabel(label: string): string {
  if (JA) return label;
  if (label === "5時間") return t("fiveHour") as string;
  if (label === "週次") return t("weekly") as string;
  return label.replace("日", "d").replace("時間", "h").replace("分", "m");
}

export const isJapanese = JA;
