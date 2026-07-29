# Vibe Island Win

[Vibe Island](https://vibeisland.app)（macOSのDynamic Islandに常駐してAIコーディングエージェントの状態を監視するアプリ）のWindows版。ノッチの代わりに、画面上部に常時最前面で浮かぶ小さなカプセル型ウィンドウでエージェントの状態を表示する。

## 構成

- **Tauri v2 (Rust) + React/TypeScript** — WPF/Electronではなく、軽量・高速なネイティブラッパーとしてTauriを採用
- `src-tauri/src/server.rs` — `127.0.0.1` で待ち受けるローカルHTTPサーバー。エージェント側（CLIツールのhookスクリプトなど）から `POST /event` でステータスを受け取り、フロントエンドにブロードキャストする
- `src-tauri/src/winfocus.rs` — Win32 APIでプロセスIDからウィンドウを前面化する「ターミナルへジャンプ」機能
- `src/App.tsx` — カプセル型オーバーレイUI。**マウスを乗せると展開**し、エージェント一覧・承認カード・質問カード・使用量バー・設定画面を表示。折りたたみ時は内容に合わせて縮む（エージェント0件で約66×28px）
- `src/sounds.ts` — Web Audio APIで生成する8bit風の効果音（音声ファイルを同梱しないのでインストーラが太らない）
- `scripts/verify-hook-safety.mjs` — 承認hookが「答え以外」を拒否に化けさせないことを検証する回帰テスト（後述）
- `scripts/lib/bridge.mjs` — 全ブリッジ共通の土台（ポート探索・POST・ターミナル解決・承認リクエスト）。各ツールのスクリプトは薄いアダプタに徹する
- `scripts/hook.mjs` — Claude Code のステータス通知
- `scripts/hook-permission.mjs` — Claude Code の承認（PreToolUse、承認モードON時のみ）
- `scripts/hook-question.mjs` — Claude Code の `AskUserQuestion` をノッチに表示
- `scripts/hook-codex.mjs` — Codex CLI の `notify` ブリッジ
- `scripts/hook-cursor.mjs` — Cursor の hooks ブリッジ（ステータス＋承認）
- `scripts/hook-gemini.mjs` — Gemini CLI の hooks ブリッジ（ステータス＋承認）
- `src-tauri/src/usage.rs` — ClaudeとCodex双方の使用率を5分おきに取得（後述）

## セットアップ

```bash
npm install
npm run tauri dev
```

## イベントAPI

ローカルサーバーは起動時に `47821`〜`47830` の空いているポートにバインドし、実際に使ったポート番号を `%LOCALAPPDATA%\VibeIslandWin\port.txt` に書き出す。エージェント連携スクリプトはこのファイルを読んでポートを特定する。

### `POST /event`（fire-and-forget、ステータス更新）

```json
{
  "session_id": "string",
  "tool": "claude | codex | gemini | cursor",
  "label": "string | null",
  "status": "running | waiting_permission | waiting_input | done | error | closed",
  "message": "string | null",
  "terminal": { "app": "string|null", "pid": "number|null", "window_title": "string|null" }
}
```

`status` が `done` / `closed` になると一覧から消える。

既知の問題として、短時間に複数の `POST /event` が競合すると稀にリクエストボディの読み取りが失敗することがある（tiny_httpのスレッド処理まわり）。hookスクリプト側は800msタイムアウト＋エラー握りつぶしのfire-and-forget設計なので、取りこぼしても次のイベントで状態は追いつく。

### `POST /permission`（ブロッキング、承認待ち）

呼び出し元をブロックしたまま、UIで「許可」「拒否」が押されるまで応答を返さない（タイムアウト5分、既定は拒否）。Claude Codeの `bypassPermissions` モードのように権限プロンプト自体が発生しない設定では出番がないため、既定のhook構成では使用していない。使う場合は呼び出し元のツールが本当にブロッキング承認に対応しているか確認すること。

```json
{ "session_id": "string", "tool": "string", "label": "string|null", "tool_name": "string", "description": "string" }
```

レスポンス: `{ "decision": "allow" | "deny" }`

## Claude Code 連携

`scripts/claude-hooks.snippet.json` に設定例一式がある。グローバル (`~/.claude/settings.json`) かプロジェクト単位 (`.claude/settings.json`) のどちらかにマージして使う。`PreToolUse` には3つのエントリが並ぶ（互いに干渉しない）:

1. `hook.mjs PreToolUse` — ステータス通知のみ。`AskUserQuestion` のときは2番目に譲るためスキップする
2. `hook-question.mjs`（matcher: `AskUserQuestion`）— 質問と選択肢をノッチに表示
3. `hook-permission.mjs` — 承認モード用。`"timeout": 310` を必ず指定すること（Rust側が最大300秒待つため、既定タイムアウトだと途中で殺される）

## 承認モード（既定OFF）

ノッチのフッターのトグルで切り替える。状態は `%LOCALAPPDATA%\VibeIslandWin\approval-mode.json` に保存され、hookスクリプトが同期的に読む。

- **OFF（既定）**: `hook-permission.mjs` はファイルを1回読んで即座に何も出力せず終了する（実測170ms、大半はNode起動時間）。ネットワークもサブプロセスも使わないので、通常の自動実行フローに実質的な影響がない
- **ON**: 全ツール実行前にノッチへ承認カードが出て、Allow/Denyを押すまでClaude Codeが待機する。`permissionDecision` は `bypassPermissions` より優先されるため、この設定でも承認が挟まる
- **Vibe Islandが起動していない/応答しない場合**: `"ask"` を返してターミナル側の通常プロンプトにフォールバックする。黙って `allow` すると承認モードが名前だけの機能になるため、あえてこの挙動にしている。ハングもしない（接続失敗は185msで判定）

### 安全策（実際に事故ったので入れた）

開発中、承認モードONの状態でサーバーが一時的にエラーボディを返し、hookがそれを**「拒否」と解釈してツール実行が全て止まる**事故が起きた。解除操作自体もブロックされるため復旧できなくなる。対策:

- **答え以外は全部 `ask`**: hookは `decision` が明示的に `"allow"` / `"deny"` のときだけそれに従う。エラーボディ・空レスポンス・パース失敗はすべて `ask` にフォールバックする。`scripts/verify-hook-safety.mjs` がこの5パターンを検証する（`node scripts/verify-hook-safety.mjs`）
- **サーバー側**: ボディをContent-Lengthと突き合わせて読み、途中で切れたら400ではなく**503**を返す。「リクエストが変」と「通信が切れた」を呼び出し側が区別できるようにするため
- **トレイに「承認モードを解除」**: オーバーレイUIに触れなくても解除でき、待機中のリクエストも全て解放する
- **ONにするとき2クリック**: 誤クリックで有効化されないよう確認ボタンを挟む。OFFは1クリックのまま（安全な方向に倒すのを妨げない）
- **終了時に自動OFF**: トレイの「終了」で必ず解除してから落ちる

## 質問表示（AskUserQuestion）

`AskUserQuestion` の質問文と選択肢をノッチに表示する。**回答はターミナルで行う** — カードをクリックするとそのターミナルにジャンプする。

ノッチから直接回答する方式（本家Mac版の挙動）は採用していない。hookはツール実行をゲートできるが回答値そのものを注入する術がなく、実現するにはターミナルを前面化して合成キー入力を送る必要がある。フォーカスが競合したときに無関係なアプリへ誤入力する危険があるため、意図的に見送っている。

## Codex CLI 連携

`~/.codex/config.toml` の `notify` を `["node", "<...>/scripts/hook-codex.mjs"]` に向ける。Codexの `notify` はターン終了時（`agent-turn-complete`）にしか飛ばないため、Claude Codeほど細かい途中経過（PreToolUseレベル）は拾えず、「実行完了・入力待ち」の粒度になる。

`notify` には1プログラムしか登録できないが、OpenAI純正のcompanion（computer-use）が入っている環境では、Codex側が `--previous-notify` で既存の通知先を自動的にチェーンしてくれる。つまり companion → こちらのスクリプト、の順で呼ばれる。**こちらから companion を呼び返してはいけない**（無限ループになる）。

## Cursor 連携

`scripts/cursor-hooks.snippet.json` を `~/.cursor/hooks.json`（ユーザー全体）か `<project>/.cursor/hooks.json` に置く。既に `hooks.json` がある場合は `hooks` の中身だけマージする。Cursorは保存を監視して自動リロードする（効かないときは再起動）。

**GUI版のCursorでもそのまま動く**（hooksはIDE側の機能）。`cursor-agent` CLI でも同じファイルを読むが、ヘッドレス時は一部イベントが発火しないという報告があるため、CLIでの網羅性は未確認。

| イベント | 表示 |
|---|---|
| `sessionStart` | 実行中（セッション開始） |
| `beforeSubmitPrompt` | 実行中（プロンプト内容） |
| `preToolUse` | 実行中（ツール名） |
| `beforeShellExecution` | 実行中（コマンド）＋承認モード時は承認カード |
| `stop` | 完了 |
| `sessionEnd` | 終了 |

承認の返り値は Claude/Gemini と**フィールド名が違う**（`{"permission":"allow"|"deny"|"ask"}`）。`failClosed` は付けていない — 付けるとVibe Islandが落ちているときにCursorの操作まで止まるため。

## Gemini CLI 連携

`scripts/gemini-hooks.snippet.json` を `~/.gemini/settings.json`（または `<project>/.gemini/settings.json`）の `hooks` キーにマージする。

| イベント | 表示 |
|---|---|
| `SessionStart` | 実行中（セッション開始） |
| `BeforeAgent` | 実行中（プロンプト内容） |
| `BeforeTool` | 実行中（ツール名）＋承認モード時は承認カード |
| `Notification` | 入力待ち |
| `AfterAgent` | 完了 |
| `SessionEnd` | 終了 |

Geminiには `"ask"` に相当する決定が無い（`allow` / `deny` / `block` のみ）。そのため承認が取れなかったときは**何も出力せず終了**し、Gemini自身のプロンプトに委ねる。

**未検証**: Cursor・Gemini CLIともこの環境に未インストールのため、実際のCLI/IDEからの発火は試せていない。代わりに各社ドキュメント通りのペイロード形状を模したスタブで `scripts/verify-bridges.mjs` を用意し、全イベントの変換とオーバーレイ表示を確認済み。Geminiの `timeout` の単位（ミリ秒か秒か）もドキュメントから確定できなかったので、実機で確認が必要。

## 使用量トラッキング

`src-tauri/src/usage.rs` が5分おきに両方のCLIから使用率を取得する。ウィンドウの長さは提供元によって違うので、`five_hour`/`seven_day` のような固定フィールドではなく `{label, utilization, resets_at_ms}` のリストとして扱う。

**Claude Code**: `~/.claude/.credentials.json` のOAuthアクセストークンで `https://api.anthropic.com/api/oauth/usage` を叩き、5時間・週次の使用率とリセット時刻を得る。非公開エンドポイントなので仕様変更で壊れる可能性がある。

**Codex CLI**: HTTPで現在の使用率を取れるエンドポイントは**存在しない**。パーセンテージは実際のモデル呼び出しのレスポンスヘッダ（`x-codex-primary-used-percent` 等）にしか乗らない。ダミーのリクエストを投げれば取れるがクォータを消費するので、CodexのTUI自身と同じ経路 — ローカルの `codex app-server`（JSON-RPC over stdio）に `account/rateLimits/read` を投げる方式にした。`codex.exe` の場所はハッシュ付きディレクトリなので、最終更新が新しいものを自動で選ぶ。プラン種別（free/plus等）も併せて表示する。

> `codex.exe` はコンソールアプリなので、起動時に **`CREATE_NO_WINDOW` を必ず指定する**こと。付け忘れるとポーリングのたび（5分ごと）に黒いコンソールウィンドウが一瞬表示される。同様に、hookスクリプトからPowerShellを呼ぶ箇所も `windowsHide: true` が必要。

どちらもトークンが無い/期限切れなら静かにスキップし、次のポーリングを待つ（自前でのトークンリフレッシュはしない）。

## ターミナルへのジャンプ（既知の制約）

セッション行をクリックすると、そのセッションが動いているターミナルの**ウィンドウ**を前面化する（`winfocus.rs` の `focus_pid`）。

**タブ・分割ペイン単位のジャンプは未対応。** Windows Terminal は複数タブが同一プロセス（WindowsTerminal.exe）を共有するため、プロセスツリーを遡る現在の方式では全タブが同じPIDに解決され区別できない。UI Automation でタブ要素を列挙する手もあるが、PIDとタブを対応づける手段がなくタブ名のあいまい一致に頼ることになり、WinUI3のオートメーションツリーもバージョン間で変わるため見送った。分割ペインに至っては指定可能なIDが存在しない。代わりにセッション行のツールチップにウィンドウタイトルを出しているので、フォーカス後にどのタブかの手がかりにはなる。

## サウンド通知

`waiting_input` / `waiting_permission` / `error` への遷移で短い効果音が鳴る。Web Audio APIで矩形波を生成しているので音声ファイルは同梱していない。フッターの🔊ボタンでミュートでき、状態は `localStorage`（`vibeisland-muted`）に保存される。同一セッションの同一状態遷移は2秒デバウンスするので鳴り続けない。

## 展開の挙動とセッション履歴

**マウスを乗せると展開**し、離すと折りたたむ（設定でOFFにできる）。ただし承認カードが出ているときや設定画面を開いているときは、ポインタが外れても勝手に閉じない — 操作の途中で消えると困るため。

折りたたみ時は内容に合わせて縮む。ウィンドウのサイズはフロントエンドが自分の実寸を測って `resize_overlay` に渡す方式なので、CSSだけで見た目とウィンドウ枠が一致する。

セッションは**完了しても消えず**、直近5件まで履歴として残る（`HISTORY_LIMIT`）。淡く表示され、実行中のものが上に来る。ただし**入力待ち・承認待ち・エラー・質問が残っているセッションは件数に関係なく残る** — 「何か確認事がある場合はセッションが動いていなくても見られる」ようにするため。セッションが `SessionEnd`（`closed`）で終わったときに質問が表示されたままだった場合、その質問も一緒に保持する（`Stop`＝`done` は正常終了なので質問は回答済みとみなしてクリアする）。

## 設定

フッターの ⚙ ボタンから開く。`%LOCALAPPDATA%\VibeIslandWin\settings.json` に保存され、変更は即座にウィンドウへ反映される。

| 項目 | 内容 |
|---|---|
| 幅 | 展開時のパネル幅（280〜720px） |
| 位置 | 画面上部の左 / 中央 / 右 |
| 上余白 | 画面上端からの距離（0〜120px） |
| 画面 | 表示するモニタ。モニタが2台以上のときだけ出る。未指定・取り外し済みならメイン画面にフォールバック |
| ホットキー | 表示/非表示のショートカット（既定 `Alt+Shift+V`、「なし」で無効化） |
| 停滞警告 | 「実行中」のまま何分更新がなければ警告するか（0で無効） |
| マウスが離れたら折りたたむ | OFFにすると開きっぱなしにできる |
| Windows起動時に自動で起動する | `HKCU\...\Run` に登録する。**インストール版で有効にすること** — 開発版で有効にすると `target\debug` のパスが登録されてしまう |

## 使用量アラート

使用率が80% / 95%を超えたタイミングで、警告音とパネル上部のバナーで知らせる。閾値は `settings.json` の `usage_alert_at` で変更できる。

同じ枠で何度も鳴らないよう、**閾値を跨いだ瞬間に一度だけ**通知する（80%で1回、その後95%に達したらもう1回）。使用率が全閾値を下回ると再武装され、次の枠でまた通知される。この挙動は `cargo test` の単体テストで固定してある。

## 停滞検知

`running` のまま一定時間（既定20分）更新がないセッションを「停滞」として警告色で表示する。自動実行で回していると固まったエージェントに気づけないため。`waiting_input` や `done` は正常な待機・終了なので対象外。

## テスト

どちらもVibe Islandを起動していなくても実行できる（スタブサーバーを自前で立てる）。実行後は `port.txt` と `approval-mode.json` を必ず元に戻す。

```bash
node scripts/verify-bridges.mjs        # 4ツール分のイベント変換と承認の返り値
node scripts/verify-hook-safety.mjs    # 承認hookが「答え以外」を拒否に化けさせないこと
cd src-tauri && cargo test --lib       # 使用量アラートの閾値ロジック
```

## 未実装 / 今後

- Cursor / Gemini CLI を実際にインストールしての実機確認
- Codex CLI 側の使用量は取得済みだが、Cursor / Gemini の使用量は未対応
- SSHリモート監視
