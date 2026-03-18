# sessionProtocolMapper 周りの 0.13.0→0.14.0-0 互換性破壊候補

## (1) sessionProtocolMapper の出力フォーマット

### フィールド一覧（SessionEnvelope）

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | string (cuid2) | エンベロープID。`createId()` で生成 |
| `time` | number | タイムスタンプ。`Date.now()` |
| `role` | `'user' \| 'agent'` | ロール |
| `turn` | string (optional) | ターンID（cuid2）。agent イベントで必須 |
| `subagent` | string (optional) | サブエージェントID。**cuid2 必須**（happy-wire schema で validate） |
| `ev` | SessionEvent | イベント本体 |

### ev.t（イベント種別）

| t | role | 主なフィールド |
|---|------|----------------|
| `text` | user/agent | `text`, `thinking?` |
| `tool-call-start` | agent | `call`, `name`, `title`, `description`, `args` |
| `tool-call-end` | agent | `call` |
| `turn-start` | agent | - |
| `turn-end` | agent | `status` |
| `start` | agent | `title?` |
| `stop` | agent | - |
| `service` | agent | `text` |
| `file` | agent | `ref`, `name`, `size`, `image?` |

### id 形式

- `id`: cuid2（`@paralleldrive/cuid2` の `createId()`）
- `turn`: cuid2
- `subagent`: cuid2（schema で `isCuid()` 検証）
- `call`（tool-call-start/end）: **プロバイダー由来の ID**（Claude の `block.id` / `tool_use_id` をそのまま使用。UUID 形式の可能性あり）

---

## (2) データ経路: sessionProtocolMapper → createEnvelope → 暗号化前

```
RawJSONLines (Claude log)
    ↓
mapClaudeLogMessageToSessionEnvelopes()  [sessionProtocolMapper.ts]
    ↓
createEnvelope(role, ev, opts)  [@slopus/happy-wire]
    ↓
SessionEnvelope[]
    ↓
apiSession.sendClaudeSessionMessage() / sendSessionProtocolMessage()
    ↓
content = { role, content: { type: 'session', data: envelope }, meta: { sentFrom: 'cli' } }
    ↓
encrypt() → socket.emit('message', ...)
```

### 呼び出し元

| 呼び出し元 | 経路 |
|------------|------|
| `apiSession.sendClaudeSessionMessage` | `claudeRemoteLauncher` / `runClaude` / `startHappyServer` から RawJSONLines を受けて `mapClaudeLogMessageToSessionEnvelopes` → `sendSessionProtocolMessage` |
| `runCursor` | `normalizeCursorMessage` → `sdkToLogConverter` → `mapClaudeLogMessageToSessionEnvelopes` → `sendSessionProtocolMessage` |
| `runCodex` | Codex 用 mapper → `sendSessionProtocolMessage` |
| `runAcp` | AcpSessionManager → `sendSessionProtocolMessage` |

---

## (3) 0.13.0 相当との互換性破壊候補（3〜5件）

### 候補1: **time の算出方法変更**（pickTimestamp 削除）

| 項目 | 内容 |
|------|------|
| 該当 | `sessionProtocolMapper.ts` L436 付近（旧 `pickTimestamp` 呼び出し） |
| 変更 | 0.13.0 相当: `message.timestamp` をパースして使用。現行: `Date.now()` のみ |
| 根拠 | 54d00311 で `pickTimestamp()` を削除し、`createEnvelope` のデフォルト `Date.now()` に統一 |
| 影響 | メッセージ順序・表示順が変わる可能性。モバイルの `createdAt` ソートに影響しうる |

### 候補2: **subagent の cuid2 必須化**

| 項目 | 内容 |
|------|------|
| 該当 | `packages/happy-wire/src/sessionProtocol.ts` L86-91, `packages/happy-app/sources/sync/typesRaw.ts` L116-118 |
| 変更 | 0.13.0 相当: `subagent` は任意の string。現行: `isCuid(value)` で validate |
| 根拠 | 011493d6 で `sessionEnvelopeSchema.subagent` に `refine(isCuid)` を追加。happy-wire の `createEnvelope` は `sessionEnvelopeSchema.parse()` を呼ぶ |
| 影響 | 0.13.0 が UUID 等の非-cuid2 を subagent に送っていた場合、parse 失敗またはモバイル側 validation でドロップ |

### 候補3: **tool-call の call ID 形式（provider ID の扱い）**

| 項目 | 内容 |
|------|------|
| 該当 | `sessionProtocolMapper.ts` L413-414, L571 |
| 変更 | `call` に Claude の `block.id` / `tool_use_id` をそのまま使用。UUID 形式の可能性 |
| 根拠 | L413: `const call = typeof block.id === 'string' && block.id.length > 0 ? block.id : createId()`。L571: `call: block.tool_use_id` |
| 影響 | 0.13.0 が cuid2 を期待していた場合、tool-call のマッチング・表示が壊れる可能性。モバイルの `tool_use_id` 参照に影響 |

### 候補4: **sessionFileEventSchema の変更（file/photo 統合）**

| 項目 | 内容 |
|------|------|
| 該当 | `packages/happy-wire/src/sessionProtocol.ts` L31-44 |
| 変更 | 0.13.0 相当: `sessionFileEventSchema`（ref, name のみ）, `sessionPhotoEventSchema` が別。現行: `file` に `size` 必須、`image` オプションで統合。`photo` は削除 |
| 根拠 | 54d00311^ の `@/sessionProtocol/types` には `sessionPhotoEventSchema` あり。happy-wire には `photo` なし |
| 影響 | 0.13.0 が `ev.t === 'photo'` を送っていた場合、現行 schema で parse 失敗 |

### 候補5: **createEnvelope の parse による厳格化**

| 項目 | 内容 |
|------|------|
| 該当 | `packages/happy-wire/src/sessionProtocol.ts` L120-128 |
| 変更 | 0.13.0 相当: プレーンオブジェクトを返すだけ。現行: `sessionEnvelopeSchema.parse()` で Zod 検証 |
| 根拠 | 54d00311^ の `createEnvelope` は `return { ... }` のみ。happy-wire は `return sessionEnvelopeSchema.parse({ ... })` |
| 影響 | subagent の cuid2、file の size など、上記のいずれかに違反するとランタイムで throw。0.13.0 では通過していた不正データが現行で失敗する |

---

## 関連コミット

```
54d00311 feat: add happy-wire and session protocol migration
011493d6 Implement cuid2 session protocol IDs across adapters
36bcc1cb feat(session-protocol): finalize subagent lifecycle protocol
```

---

## 次に読むべきファイル

1. **`packages/happy-app/sources/sync/typesRaw.ts`** — モバイル側の `sessionEnvelopeSchema` と `normalizeSessionEnvelope`。`rawRecordSchema.safeParse` 失敗時の挙動。
2. **`packages/happy-wire/src/sessionProtocol.ts`** — `createEnvelope` と schema の詳細。
3. **`packages/happy-cli/src/api/apiSession.ts`** — `sendSessionProtocolMessage` のラップ形式（`content.type: 'session'`）と暗号化前ペイロード。
4. **`packages/happy-server/`** — サーバー側の session メッセージ受信・ブロードキャスト処理（モバイルへの転送経路）。
5. **`docs/plans/npm-0.13.0-codebase-identification.md`** — 0.13.0 の gitHead とソース特定手順。
