# Cursor Agent Runner — スレッド引き継ぎプロンプト

以下を新スレッドの最初のメッセージとしてコピペする。

---

## コンテキスト

Cursor Agent CLI の出力を Happy Coder モバイルアプリでリモートモニタリングする機能を実装中。
実装は完了（テスト全パス、ビルド成功）しているが、E2E 検証でモバイルアプリへのメッセージ表示が未完了。

### 前スレッドの成果

- Issue: [#876](https://github.com/slopus/happy/issues/876)
- Branch: `feature/#876_cursor_agent_runner` (origin に push 済み)
- コミット: `ad8e9975`

### 必読ファイル

以下を順に読んでコンテキストを復元してください:

1. `@docs/plans/cursor-agent-runner.md` — キックオフドキュメント（設計・マッピング仕様）
2. `@docs/plans/cursor-agent-runner-debug-findings.md` — E2E デバッグの全調査結果（根本原因確定済み）

### 実装済みファイル（全て `packages/happy-cli/src/cursor/`）

| ファイル | 役割 | 状態 |
|---|---|---|
| `normalizeCursorMessage.ts` | Cursor stream-json → Claude SDKMessage 正規化 | 完了（21 テストパス） |
| `normalizeCursorMessage.test.ts` | 正規化テスト | 完了 |
| `cursorProcess.ts` | cursor-agent バイナリ検出・spawn・stdout パース | 完了（6 テストパス） |
| `cursorProcess.test.ts` | プロセス管理テスト | 完了 |
| `runCursor.ts` | メインランナー（セッション作成、パイプライン、双方向、クリーンアップ） | 完了 |
| `__fixtures__/cursor-stream-test.jsonl` | 実機取得テストデータ | 完了 |

### 変更済みの既存ファイル

| ファイル | 変更内容 |
|---|---|
| `packages/happy-cli/src/index.ts` | `happy cursor` サブコマンド追加 |
| `packages/happy-cli/src/api/apiSession.ts` | `sendLegacyLogMessage` メソッド追加（0.13.0 互換 wire format） |

### TODO 状態（前スレッドのプランから）

#### 完了済み

- [x] Pre-Implementation（yarn install/build、フィクスチャ保存、Issue作成、ブランチ作成）
- [x] Task 1: 正規化レイヤー normalizeCursorMessage（実装 + テスト 21/21）
- [x] GATE: Task 1 テスト全パス
- [x] Task 2: プロセス管理 cursorProcess（実装 + テスト 6/6）
- [x] GATE: Task 2 テスト全パス
- [x] Task 3a: runCursor 読取専用 MVP（全サブタスク実装済み）
- [x] Task 3b: モバイルからの入力送信（双方向化、runCursor に統合済み）
- [x] Task 4: CLI エントリポイント登録
- [x] GATE: ビルドパス

#### 未完了 — E2E 検証

- [ ] GATE: `happy cursor` でモバイルアプリにメッセージが表示される
- [ ] HG-1: ユーザー事前作業 — `happy auth login` 完了済み、`happy-agent auth login` は 404 エラー
- [ ] HG-1.5: Claude Code で正常動作体験 — フォーク版では未検証（npm 0.13.0 グローバル版では動作確認済み）
- [ ] HG-2: iOS アプリ目視確認
- [ ] HG-3: 双方向検証
- [ ] Task 5: E2E 動作検証（全項目）

### E2E ブロッカー: 根本原因と対処（確定済み）

**問題 1: サーバー URL**

`HAPPY_SERVER_URL` 環境変数が未設定だと `https://api.cluster-fluster.com`（デフォルト）に接続して 404。
正しくは `https://api.happy-servers.com`。

```bash
export HAPPY_SERVER_URL=https://api.happy-servers.com
```

**問題 2: アプリの session protocol feature flag**

App Store 版アプリは `EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND` が未設定（false）。
結果、`type: 'session'` 形式のメッセージは `normalizeRawMessage()` 内で silent DROP される。

`packages/happy-app/sources/sync/typesRaw.ts` L20-27, L595, L727 参照。

フラグ OFF（App Store）→ `type: 'output'` 形式のみ表示可能
フラグ ON（開発版）→ `type: 'session'` 形式のみ表示可能

**対処**: `runCursor.ts` は `sendLegacyLogMessage`（`type: 'output'` + RawJSONLines 直接送信）を使用。
`sessionProtocolMapper` をバイパスし、`sdkToLogConverter` の出力を直接 0.13.0 形式で送信する。
これは既にコミット済み。

### 次のアクション（優先順）

1. `export HAPPY_SERVER_URL=https://api.happy-servers.com` を設定
2. `./packages/happy-cli/bin/happy.mjs cursor` を起動
3. iPhone のアプリからプロンプトを送信し、レスポンスが表示されるか確認
4. 表示されれば HG-2（目視確認）→ HG-3（双方向検証）→ Task 5 完了
5. 表示されなければ、`sendLegacyLogMessage` のデバッグ（ログで送信フォーマットを確認）

### 注意事項

- `happy-agent auth login` は 404 エラーで使えない。Task 5 の CLI 検証コマンド（`happy-agent list/history/status`）は使用不可。アプリの目視確認で代替
- Node.js は v22.16.0 が必要（`.tool-versions` で設定済み、asdf 使用）
- Cursor CLI の API トークン消費に注意（短いプロンプト推奨）
- origin/main の `happy claude` / `happy codex` もフォーク版ではモバイル表示されない（同じ feature flag 問題）
