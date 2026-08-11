# Roost プロジェクト概要

Windows用の常時最前面パネル。Claude Code / Codex CLI / Cursor / Gemini CLI の稼働状況・承認待ち・使用量クォータを1枚のパネルに集約し、行クリックで元のターミナルにフォーカスを戻す。Tauri（Rust + React）製、インストール約11MB。

リポジトリ: https://github.com/Yuuki3150/roost （ブランチ: `master`）
公開ドキュメントは `README.md` / `README.ja.md`。**仕様の詳しい説明はREADMEが正**なので、挙動を変えたらREADMEも両方更新する。

## 構成マップ

| 役割 | 場所 |
|---|---|
| パネルUI全体（表示・展開・承認ボタン） | `src/App.tsx` |
| UI文言（英日切り替え） | `src/i18n.ts` |
| 通知音 | `src/sounds.ts` |
| Tauriエントリ・トレイ・ウィンドウ制御 | `src-tauri/src/lib.rs` |
| ローカルHTTPサーバ（エージェントからの受け口） | `src-tauri/src/server.rs` |
| セッション状態の保持・履歴 | `src-tauri/src/state.rs` |
| 使用量クォータ取得（Anthropic / OpenAI） | `src-tauri/src/usage.rs` |
| ウィンドウ探索・フォーカス復帰 | `src-tauri/src/winfocus.rs` |
| 各エージェント用ブリッジ本体 | `scripts/lib/bridge.mjs` |
| Claude Code用フック | `scripts/hook.mjs`, `hook-question.mjs`, `hook-permission.mjs` |
| Codex / Cursor / Gemini 用フック | `scripts/hook-codex.mjs`, `hook-cursor.mjs`, `hook-gemini.mjs` |
| 各エージェントの設定ファイル書き換え | `scripts/setup.mjs` |
| テスト | `scripts/verify-bridges.mjs`, `scripts/verify-hook-safety.mjs`, `src-tauri` の `cargo test` |

## 重要な設計判断（変更しないこと）

- **承認は「明示的なallow/denyだけ」を採用する**。通信エラー・空レスポンス・パース不能はすべて「エージェント自身のプロンプトにフォールバック」。不具合を拒否として扱うと、ユーザーが見ていないところで作業が止まる（開発中に実際に起きた）。この挙動は `scripts/verify-hook-safety.mjs` で固定してある
- **すべてのブリッジはfail-quiet**。Roostが起動していなければ1秒未満でタイムアウトし、エージェント側は何事もなく続行する。ここにブロッキングを持ち込まない
- **承認モードはデフォルトOFF**。自律実行しているエージェントを毎ツール呼び出しで止めたら意味がないため。トレイからも必ずOFFにできるようにしておく（自分をロックアウトさせない）
- **すべてローカル完結**。通信は `127.0.0.1` のみ。サーバ・アカウント・テレメトリを増やさない
- **認証情報は読むだけ**。`~/.claude/.credentials.json` と `~/.codex/auth.json` を読み、本人自身の使用量を問い合わせる用途にのみ使う。保存・ログ出力・第三者送信は一切しない（`src-tauri/src/usage.rs`）
- **使用量エンドポイントは非公式**。壊れたらバーが消えるだけ、という degradation を保つ
- UI言語はOS言語追従（日本語Windows以外は英語）。`ROOST_LANG=en|ja` で上書き可能
- Cursor / Gemini は実機未検証。公式ドキュメントベースの実装で、スタブに対する `verify-bridges.mjs` で担保している

## コマンド

```bash
npm install
npm run tauri dev      # 開発（パネルを起動して確認）
npm run dev            # フロントのみ（Vite）
npm run tauri build    # インストーラ生成（未署名）
npm test               # ブリッジのイベント対応 + 承認の安全性
cd src-tauri && cargo test --lib   # 使用量アラート閾値
```

エージェント側の配線:

```bash
npm run setup                # 見つかったエージェントすべてにフック設定を書く
npm run setup -- --dry-run   # 書かずにプレビュー
npm run setup -- --remove    # 取り外す
```

`~/.claude/settings.json` / `~/.cursor/hooks.json` / `~/.gemini/settings.json` をその場で書き換え、元を `*.roost-backup` として残す。Codex CLI だけは `~/.codex/config.toml` に1行貼る必要があり、スクリプトがその行を表示する。

## 運用ルール

- 挙動を変えたら `npm test` を通す。承認まわりを触ったときは `verify-hook-safety.mjs` が緑であることを必ず確認する
- README.md と README.ja.md は対になっている。片方だけ更新しない
- リリースは未署名インストーラ。SmartScreen警告が出る前提の案内をREADMEから消さない
- 会話は日本語

## エージェント共通設定（Claude Code / Codex）

このファイルが唯一の指示書。`CLAUDE.md` は `@AGENTS.md` を読み込むだけのエイリアスなので、**ルールを追記するときは必ずこのファイルに書く**。

Codex で作業するときの注意:

- Roost自身がCodexの `notify` フック（`scripts/hook-codex.mjs`）で動いている。`~/.codex/config.toml` の `notify` 行を壊すと、Codexセッションがパネルに出なくなる。config.toml を触るときは既存の `notify` を保持すること
- Codexの `notify` はターン境界でしか発火しない（ツール単位のイベントがない）。Claude Codeと同じ粒度で出ないのは仕様
- `npm run tauri dev` / `cargo test` はビルドに時間がかかる。バックグラウンド実行にして待つ
