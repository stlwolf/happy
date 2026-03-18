# Cursor Agent Runner — デバッグ調査結果

## 実施日: 2026-03-18

## 1. 実装状況

### 完了済み（テスト全パス、ビルド成功）
- `packages/happy-cli/src/cursor/normalizeCursorMessage.ts` — Cursor → Claude SDKMessage 正規化（21/21 テストパス）
- `packages/happy-cli/src/cursor/normalizeCursorMessage.test.ts`
- `packages/happy-cli/src/cursor/cursorProcess.ts` — プロセス管理（6/6 テストパス）
- `packages/happy-cli/src/cursor/cursorProcess.test.ts`
- `packages/happy-cli/src/cursor/runCursor.ts` — メインランナー（セッション作成、keepAlive、正規化パイプライン、双方向対応、abort/kill、クリーンアップ）
- `packages/happy-cli/src/cursor/__fixtures__/cursor-stream-test.jsonl`
- `packages/happy-cli/src/index.ts` — `happy cursor` サブコマンド追加
- `.tool-versions` — `nodejs v22.16.0`

### 修正済みバグ
- `runCursor.ts` の `await sessionId` デッドロック — async generator が未イテレーション状態で sessionId Promise を await していた → `.then()` に変更

## 2. E2E 検証で発見した問題と調査結果

### 問題 A: サーバー URL

**`HAPPY_SERVER_URL` 環境変数が設定されていない場合、デフォルトは `https://api.cluster-fluster.com`。**

| ファイル | 行 | 内容 |
|---|---|---|
| `packages/happy-cli/src/configuration.ts` | 32 | `this.serverUrl = process.env.HAPPY_SERVER_URL \|\| 'https://api.cluster-fluster.com'` |

以前のテスト（セッション作成成功）では `HAPPY_SERVER_URL` が設定されていた。`auth login --force` を別プロセスで実行した際に環境変数が引き継がれず、`api.cluster-fluster.com` に接続して 404 エラー。

**対処**: 実行前に `export HAPPY_SERVER_URL=https://api.happy-servers.com` を設定するか、`.envrc` に記載。

### 問題 B: メッセージ wire format

#### コードレベルで確認済みの事実

**npm 0.13.0（gitHead: `7fa59e53`）の送信パス**:
```
SDKMessage → sdkToLogConverter → RawJSONLines → sendClaudeSessionMessage
→ { role: 'agent', content: { type: 'output', data: RawJSONLines } }
→ socket.emit('message', { sid, message: encrypted })
```
- `sessionProtocolMapper.ts` は存在しない
- `happy-wire` パッケージは存在しない
- 0.13.0 は monorepo 化前（`src/` 直下構造）

**フォーク 0.14.0-0（origin/main）の送信パス**:
```
SDKMessage → sdkToLogConverter → RawJSONLines → sendClaudeSessionMessage
→ mapClaudeLogMessageToSessionEnvelopes → SessionEnvelope[]
→ sendSessionProtocolMessage
→ { role: envelope.role, content: { type: 'session', data: SessionEnvelope } }
→ socket.emit('message', { sid, message: encrypted })
```

**変更されていないもの（コード比較で確認済み）**:
- Socket.IO 接続設定（auth, path, transports）: 同一
- socket.io-client バージョン: ^4.8.1（同一）
- セッション作成 POST /v1/sessions のリクエストボディ: 同一
- 暗号化ロジック: 同一
- コンストラクタ: 同一

#### アプリ側のメッセージ処理（コード確認済み）

**`packages/happy-app/sources/sync/typesRaw.ts`**:
- L968-969: `content.type === 'session'` → `normalizeSessionEnvelope()` で処理可能
- L750-881: `content.type === 'output'` → `RawJSONLines` として処理
- サポートしている content.type: `output`, `event`, `codex`, `session`, `acp`

**→ アプリは `type: 'session'`（SessionEnvelope 形式）を処理できるコードを持っている。**

ただし App Store 版（1.5.0）とソース版（1.6.2）の差がある。Expo OTA アップデートで JS バンドルが更新されていれば 1.5.0 でも session protocol 対応。

#### サーバー側の socket.on('message') ハンドラ（コード確認済み）

**`packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts`** L186-245:
- `socket.on('message', ...)` ハンドラは存在する
- 暗号化ペイロードを DB に保存（`db.sessionMessage.create()`）
- `eventRouter.emitUpdate()` で他クライアントにブロードキャスト
- **`skipSenderConnection: connection`** で送信者自身にはブロードキャストしない（これが CLI 側でエコーバックがなかった理由）

#### `sendCodexMessage` が使われていない（コード確認済み）

`runCodex.ts` は `sendCodexMessage` を一切呼んでいない。全て `sendSessionProtocolMessage` 経由に移行済み。`sendCodexMessage` はデッドコード。

### 問題 B の根本原因（確定）

**アプリに `isSessionProtocolSendEnabled()` feature flag が存在する。**

`packages/happy-app/sources/sync/typesRaw.ts` L20-27:
```typescript
function isSessionProtocolSendEnabled(): boolean {
    const raw = (
        process.env.EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND
        ?? process.env.ENABLE_SESSION_PROTOCOL_SEND
        ?? ''
    ).toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}
```

App Store 版はこの環境変数が未設定 → **false**。結果:
- L595: `normalizeSessionEnvelope` 内で `role === 'user'` かつ `ev.t === 'text'` のメッセージが `!isSessionProtocolSendEnabled()` で **null（DROP）**
- L727: 旧形式 `role === 'user'` のメッセージは `isSessionProtocolSendEnabled()` が true のとき **DROP**（排他制御）
- つまりフラグ OFF（App Store）では `type: 'output'` 形式のみ表示可能
- フラグ ON（開発版）では `type: 'session'` 形式のみ表示可能

**サーバーにはメッセージが届いていたが（`skipSenderConnection` でエコーなし）、アプリ側で feature flag により DROP されていた。**

これにより `sendLegacyLogMessage`（`type: 'output'` + RawJSONLines 直接送信）が正しい修正方針であることが確定。

## 3. `apiSession.ts` の現在の状態

origin/main の内容 + `sendLegacyLogMessage` メソッドを追加した状態。
`runCursor.ts` は `sendLegacyLogMessage` を使用（sessionProtocolMapper をバイパス）。

## 4. 次のアクション

### 最優先: サーバー URL を正しく設定して再テスト
```bash
export HAPPY_SERVER_URL=https://api.happy-servers.com
./packages/happy-cli/bin/happy.mjs cursor
```

### origin/main の sendSessionProtocolMessage で動くかテスト
サーバー URL が正しい状態で、`sendSessionProtocolMessage`（`type: 'session'` 形式）のままテスト。
アプリが OTA で session protocol 対応していれば表示されるはず。

### sendLegacyLogMessage がフォールバックとして動くかテスト
session protocol で動かない場合、`sendLegacyLogMessage`（`type: 'output'` + RawJSONLines 直接送信）でテスト。

### 両方ダメな場合
アプリの OTA バージョンが session protocol 非対応。npm 0.13.0 互換の送信パスが必要。
`sendLegacyLogMessage` の方式で `HAPPY_SERVER_URL` を正しく設定すれば動くはず。

## 5. 参照ファイル

| ファイル | 役割 |
|---|---|
| `packages/happy-cli/src/api/apiSession.ts` | セッション通信（sendClaudeSessionMessage, sendSessionProtocolMessage, sendLegacyLogMessage） |
| `packages/happy-cli/src/configuration.ts:32` | serverUrl のデフォルト値 |
| `packages/happy-cli/src/claude/utils/sessionProtocolMapper.ts` | SessionEnvelope 変換 |
| `packages/happy-app/sources/sync/typesRaw.ts` | アプリ側のメッセージ正規化（normalizeSessionEnvelope） |
| `packages/happy-app/sources/utils/messageUtils.ts` | アプリ側のメッセージ表示（extractClaudeTextContent） |
| `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts` | サーバーの socket message ハンドラ |
| `docs/plans/cursor-agent-runner.md` | キックオフドキュメント |

## 6. Issue / ブランチ

- Issue: [#876](https://github.com/slopus/happy/issues/876)
- Branch: `feature/#876_cursor_agent_runner`
