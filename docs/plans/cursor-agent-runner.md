# Cursor Agent Runner

## Overview

Cursor Agent CLI (`cursor agent --print --output-format stream-json`) の出力を Happy Coder のインフラでリモートモニタリングする。Cursor の stream-json 出力は Claude Code と**部分的に互換**（`system`, `user`, `assistant`, `result` は同一スキーマ）だが、`tool_call` と `thinking` は**独自形式**のため、Cursor → Claude 互換フォーマットへの正規化レイヤーが必要。

## Context

- **Cursor Agent CLI** (`cursor-agent` v2026.03.11-6dfa30c)
- **検証済み（2026-03-18 実機検証）:**
  - `system`, `user`, `assistant`, `result` メッセージは Claude Code と同一スキーマ
  - `tool_call` は**完全に独自形式**（`type:"tool_call"` + `subtype:"started"/"completed"` + oneOf ツール型）
  - `thinking` はトップレベル `type:"thinking"` のみ。`assistant` メッセージの content に thinking blocks は**含まれない**
  - `--mcp-config` フラグは**存在しない**。MCP 設定は `~/.cursor/mcp.json` / `<workspace>/.cursor/mcp.json` ファイルベース
  - `--print` モードは**1回実行で終了**（REPL ではない）。stdin 継続監視なし
- **既存の Claude runner** (`src/claude/`) の `sdkToLogConverter` + `sessionProtocolMapper` パイプラインを正規化レイヤー経由で再利用
- 暗号化層・サーバー・モバイルアプリは変更不要
- **upstream への PR は出さない**（フォーク独自拡張として維持）

### Architecture Decision

**ACP Route**: cursor-agent に ACP フラグなし → 却下（2026-03-17 検証）

**Claude Runner Route（正規化レイヤー付き）**: Cursor 独自の `tool_call` / `thinking` を Claude 互換フォーマットに正規化し、既存の `sdkToLogConverter` → `sessionProtocolMapper` パイプラインを通す。正規化ロジックは `src/cursor/` に隔離。共有モジュールは一切変更しない。

**送信経路**: `runAcp.ts` と同じ `session.sendSessionProtocolMessage(envelope)` を使用（Claude legacy の `sendClaudeSessionMessage` ではない）

### Cursor stream-json 出力フォーマット（実機検証済み）

```jsonl
{"type":"system","subtype":"init","apiKeySource":"login","cwd":"...","session_id":"...","model":"Claude 4.6 Opus (Thinking)","permissionMode":"default"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"session_id":"..."}
{"type":"thinking","subtype":"delta","text":"The","session_id":"...","timestamp_ms":...}
{"type":"thinking","subtype":"delta","text":" user wants","session_id":"...","timestamp_ms":...}
{"type":"thinking","subtype":"completed","session_id":"...","timestamp_ms":...}
{"type":"tool_call","subtype":"started","call_id":"toolu_01EJ7...","tool_call":{"editToolCall":{"args":{"path":"...","streamContent":"..."}}},"model_call_id":"...","session_id":"...","timestamp_ms":...}
{"type":"tool_call","subtype":"completed","call_id":"toolu_01EJ7...","tool_call":{"editToolCall":{"args":{...},"result":{"success":{"path":"...","linesAdded":1,"diffString":"..."}}}},"session_id":"...","timestamp_ms":...}
{"type":"tool_call","subtype":"started","call_id":"toolu_01WCy...","tool_call":{"shellToolCall":{"args":{"command":"ls",...},"description":"List files"}},"session_id":"...","timestamp_ms":...}
{"type":"tool_call","subtype":"completed","call_id":"toolu_01WCy...","tool_call":{"shellToolCall":{"args":{...},"result":{"success":{"exitCode":0,"stdout":"hello.txt\n",...}}}},"session_id":"...","timestamp_ms":...}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello.txt を作成しました..."}]},"session_id":"..."}
{"type":"result","subtype":"success","duration_ms":12239,"is_error":false,"result":"...","session_id":"...","usage":{"inputTokens":4,"outputTokens":255,...}}
```

### Cursor → Claude 正規化マッピング

| Cursor イベント | Claude 互換出力 | 備考 |
|---|---|---|
| `type:"system"` | **pass-through** | 同一形式 |
| `type:"user"` | **pass-through** | 同一形式 |
| `type:"thinking" subtype:"delta"` | テキストを**バッファに蓄積** | 即時送信しない |
| `type:"thinking" subtype:"completed"` | `type:"assistant"` + `content:[{type:"thinking",thinking:accumulatedText}]` を emit、バッファクリア | 蓄積した全 thinking を 1 メッセージに |
| `type:"tool_call" subtype:"started"` | `type:"assistant"` + `content:[{type:"tool_use",id:call_id,name:extractName(),input:extractArgs()}]` | ツール名は oneOf フィールド名から推定 |
| `type:"tool_call" subtype:"completed"` | `type:"user"` + `content:[{type:"tool_result",tool_use_id:call_id,content:formatResult()}]` | 結果を文字列化 |
| `type:"assistant"` | **pass-through** | 同一形式（content に thinking なし） |
| `type:"result"` | **drop** (null) | runner レベルでプロセス終了を検知 |

### ツール名の推定ルール

| tool_call の oneOf フィールド | 推定ツール名 | SessionProtocol の title/description |
|---|---|---|
| `editToolCall` | `Write` | `Write to file` / path を description に |
| `shellToolCall` | `Shell` | `Run command` / command を description に |
| (その他) | フィールド名をそのまま使用 | — |

## Development Approach

- 共有モジュール（`sdkToLogConverter`, `sessionProtocolMapper`, `OutgoingMessageQueue`, `sdk/stream.ts`）は**変更しない**
- 正規化ロジックは `src/cursor/` に完全隔離
- `runAcp.ts` のセッション作成・keepAlive・クリーンアップパターンを踏襲
- テストは正規化レイヤーに集中（パイプライン全体のテストは既存カバレッジに依存）
- Complete each task fully before moving to the next

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with + prefix
- Document issues/blockers with !! prefix

## Pre-Implementation Checklist

**完了済み（AI 実行）:**
- [x] upstream remote 追加 + main 同期（2026-03-17）
- [x] ACP 対応確認 → 非対応確定（2026-03-17）
- [x] cursor-agent CLI ヘルプ全オプション取得（2026-03-17）
- [x] ピアレビュー実施 → thinking 処理の不一致を発見（2026-03-18）
- [x] arena-compare 実施 → 入力境界正規化アプローチで合意（2026-03-18）
- [x] 実機検証 → tool_call 独自形式を発見、--mcp-config なし、--print は 1-shot（2026-03-18）
- [x] 既存実装の徹底調査（claudeRemoteLauncher, runAcp, session作成, OutgoingMessageQueue）（2026-03-18）

**未実施（AI が実装開始時に実行）:**
- [ ] `yarn install` — 依存関係インストール
- [ ] `yarn build` — ビルド通過確認
- [ ] テストフィクスチャ保存 — `tmp/cursor-stream-test.jsonl` → `src/cursor/__fixtures__/cursor-stream-test.jsonl`
- [ ] `--resume` 引数の仕様検証 — `cursor-agent --resume <session_id> --print ...` を実行して確認（Task 3b の前提条件）
- [ ] Issue 作成 — `gh issue create`
- [ ] feature branch 作成

## 🚧 ユーザー事前作業（モバイル/物理デバイス必須）

**以下は AI では実行不可能で、ユーザーが手動で行う必要がある作業。**
**実装は Task 3a の GATE まで進められるが、E2E 検証（iOS アプリ確認）にはこれらが必須。**

### ⚠️ 注意事項（事前に確認）

- **Cursor Pro/Business サブスクリプション**: `cursor-agent` の API 呼び出しでトークンを消費する。E2E テスト（Task 5）や `--resume` 検証のたびにコストが発生する。開発中のデバッグには短い簡単なプロンプト（例: `"say hello"`）を推奨
- **公式サーバー接続**: フォーク版 CLI で `happy.engineering` 公式サーバーに接続する。MIT ライセンスで改変は許可されているが、正規化レイヤーのバグで不正なデータを送信するとアカウント制限のリスクがある。**開発初期はテスト用アカウントの使用を推奨**
- **Cursor CLI 認証**: AI が `cursor-agent` を実行中に認証トークンが切れた場合、ブラウザ認証を求められて AI の実行がブロックされる可能性がある。事前に `cursor-agent --version` で認証状態を確認しておく

### Step 1: Happy Coder アカウント作成

1. ブラウザで [https://happy.engineering](https://happy.engineering) にアクセス
2. アカウント作成（GitHub 連携推奨）
3. ログイン確認

### Step 2: iOS アプリインストール

1. iPhone の App Store で「Happy Coder」を検索
2. インストール
3. アプリを開いてログイン（Step 1 で作成したアカウント）

### Step 3: `happy auth login`（CLI → モバイル認証）

```bash
cd /Users/eddy/work/repos/github.com/stlwolf/happy
./packages/happy-cli/bin/happy.mjs auth login
```

認証方法は 2 つから選択:
- **Mobile App（QR スキャン）**: ターミナルに QR コードが表示される → iPhone の Happy アプリでスキャン（アプリ内の「デバイス連携」「Link Device」等の機能を探す）
- **Web Browser（代替手段）**: ブラウザが開いて認証 → QR がスキャンできない場合はこちら

認証完了後、`~/.happy/access.key` が作成される。

### Step 4: `happy-agent auth login`（E2E 検証ツール用、**必須**）

Task 5 で `happy-agent list`, `happy-agent history`, `happy-agent status` を使用するため必須。

```bash
cd /Users/eddy/work/repos/github.com/stlwolf/happy
./packages/happy-agent/bin/happy-agent.mjs auth login
```

QR コードをスキャン（happy-agent は QR のみ、Web Browser 認証なし。2 分でタイムアウト）。
`~/.happy/agent.key` が作成される。

### QR スキャン失敗時のトラブルシューティング

1. `Ctrl-C` で中断し、コマンドを再実行
2. QR がスキャンできない場合:
   - `happy auth login` → 選択肢で「Web Browser」を選ぶ
   - `happy-agent auth login` → QR のみ。ターミナルを全画面化、フォントサイズ拡大して再試行
3. `"Failed to decrypt response"` → アプリのログイン状態を確認、再実行
4. ネットワークエラー → iPhone と Mac が同じネットワーク上である必要はない（サーバー経由ポーリング方式）
5. 認証状態の確認: `happy auth status` / `happy-agent auth status`

### 確認方法（AI が実行）

```bash
./packages/happy-cli/bin/happy.mjs auth status
./packages/happy-agent/bin/happy-agent.mjs auth status
```

## Human Gates（プラン実行中の一時停止ポイント）

プラン実行中、以下のポイントで**ユーザー作業待ち**のため一時停止する。
AI はゲートに到達したらユーザーに通知し、作業完了の確認を得てから次に進む。

| Gate | タイミング | ユーザー作業 | AI が次に進める条件 |
|------|----------|------------|-------------------|
| **HG-1** | Task 3a GATE 到達時 | 上記 Step 1〜4 を全て完了する | `happy auth status` + `happy-agent auth status` で認証確認 |
| **HG-2** | Task 5 読取 MVP 検証時 | iPhone で Happy アプリを開き、セッション一覧にセッションが表示されるか目視確認 → 結果を報告 | ユーザーの報告（OK / NG + スクショ） |
| **HG-3** | Task 5 双方向検証時 | iPhone の Happy アプリからメッセージを送信し、Cursor が応答するか確認 → 結果を報告 | ユーザーの報告（OK / NG） |

**注意:**
- HG-1 は Task 1, Task 2, Task 4（ビルド確認）まで到達可能。実装自体はブロックされない
- HG-2, HG-3 は Task 5 のみで発生
- ユニットテスト・統合テストは全て AI 側で実行可能（Human Gate なし）

## Implementation Steps

### Task 1: 正規化レイヤー `normalizeCursorMessage()`

Cursor の stream-json メッセージを Claude 互換の `SDKMessage` に変換するステートフル関数。実装の核心。

**File**: `packages/happy-cli/src/cursor/normalizeCursorMessage.ts`

**インターフェース**:

```typescript
import type { SDKMessage, SDKAssistantMessage, SDKUserMessage } from '@/claude/sdk';

interface CursorNormalizerState {
  thinkingBuffer: string;
}

function createCursorNormalizer(): {
  normalize: (msg: Record<string, unknown>) => SDKMessage[];
  flush: () => SDKMessage[];
}
```

- `normalize()`: 1 Cursor メッセージ → 0〜N Claude 互換 `SDKMessage`
- `flush()`: バッファされた thinking を強制 emit（プロセス終了時に呼ぶ）

**正規化ロジック（擬似コード）**:

```typescript
function normalize(msg): SDKMessage[] {
  switch (msg.type) {
    case 'thinking':
      if (msg.subtype === 'delta') {
        state.thinkingBuffer += msg.text;
        return [];
      }
      if (msg.subtype === 'completed') {
        if (!state.thinkingBuffer) return [];
        const result = [{
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: state.thinkingBuffer }]
          }
        }];
        state.thinkingBuffer = '';
        return result;
      }
      return [];

    case 'tool_call':
      if (msg.subtype === 'started') {
        const { name, title, args } = extractToolInfo(msg.tool_call);
        return [{
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: msg.call_id,
              name,
              input: { ...args, description: title }
            }]
          }
        }];
      }
      if (msg.subtype === 'completed') {
        return [{
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: msg.call_id,
              content: formatToolResult(msg.tool_call)
            }]
          }
        }];
      }
      return [];

    case 'result':
      return []; // runner レベルでプロセス終了を検知

    default:
      return [msg as SDKMessage]; // system, user, assistant は pass-through
  }
}
```

**ツール情報抽出**:

```typescript
function extractToolInfo(toolCall: Record<string, unknown>): { name: string; title: string; args: Record<string, unknown> } {
  if ('editToolCall' in toolCall) {
    const edit = toolCall.editToolCall as { args: { path: string; streamContent?: string } };
    return {
      name: 'Write',
      title: `Write to ${edit.args.path}`,
      args: edit.args
    };
  }
  if ('shellToolCall' in toolCall) {
    const shell = toolCall.shellToolCall as { args: { command: string }; description?: string };
    return {
      name: 'Shell',
      title: shell.description || `Run: ${shell.args.command}`,
      args: shell.args
    };
  }
  // 未知のツール型: フィールド名をそのまま使用
  const key = Object.keys(toolCall)[0];
  return { name: key, title: key, args: (toolCall[key] as any)?.args || {} };
}

function formatToolResult(toolCall: Record<string, unknown>): string {
  // oneOf フィールドから result を抽出して文字列化
  const key = Object.keys(toolCall)[0];
  const inner = (toolCall[key] as any)?.result;
  if (!inner) return 'No result';
  if (inner.success) {
    if (inner.success.stdout) return inner.success.stdout;
    if (inner.success.message) return inner.success.message;
    return JSON.stringify(inner.success);
  }
  if (inner.error) return `Error: ${JSON.stringify(inner.error)}`;
  return JSON.stringify(inner);
}
```

**テスト**: `normalizeCursorMessage.test.ts`

| テストケース | 入力 | 期待出力 |
|---|---|---|
| system pass-through | `{type:"system",subtype:"init",...}` | 同一オブジェクト 1 件 |
| user pass-through | `{type:"user",message:{...}}` | 同一オブジェクト 1 件 |
| thinking delta 蓄積 | `{type:"thinking",subtype:"delta",text:"Hello"}` | 空配列 |
| thinking completed | delta×3 → completed | assistant + content[thinking] 1 件 |
| thinking completed（空バッファ） | completed のみ | 空配列 |
| editToolCall started | `{type:"tool_call",subtype:"started",call_id:"t1",tool_call:{editToolCall:{args:{path:"..."}}}}` | assistant + content[tool_use] 1 件、name="Write" |
| shellToolCall started | `{type:"tool_call",subtype:"started",...shellToolCall...}` | assistant + content[tool_use] 1 件、name="Shell" |
| tool_call completed | `{type:"tool_call",subtype:"completed",call_id:"t1",...result...}` | user + content[tool_result] 1 件 |
| result drop | `{type:"result",subtype:"success"}` | 空配列 |
| assistant pass-through | `{type:"assistant",message:{...}}` | 同一オブジェクト 1 件 |
| full sequence | system→user→thinking×N→completed→tool_call started→completed→assistant→result | 正しい順序で正しい型の SDKMessage 列 |
| flush() | thinking delta×3、flush() | assistant + content[thinking] 1 件 |

**チェックリスト**:
- [ ] `createCursorNormalizer()` の実装
- [ ] `extractToolInfo()` の実装（editToolCall, shellToolCall, 未知ツール）
- [ ] `formatToolResult()` の実装
- [ ] thinking バッファリングのテスト
- [ ] tool_call 正規化のテスト
- [ ] pass-through のテスト
- [ ] full sequence テスト
- [ ] flush() のテスト
- [ ] !! GATE: テスト全パス

### Task 2: Cursor プロセス管理

Cursor Agent CLI の検出・起動・stdout パース。

**File**: `packages/happy-cli/src/cursor/cursorProcess.ts`

**バイナリ検出** (`getCursorAgentPath()`):

```typescript
// 検出優先順:
// 1. HAPPY_CURSOR_PATH 環境変数
// 2. ~/.local/bin/agent（cursor-agent 直接パス）
// 3. ~/.local/share/cursor-agent/versions/*/cursor-agent（バージョンディレクトリ）
// 4. which cursor → shim 経由（最終手段）
```

**spawn 引数**:

```
<cursor-agent-path> --print --output-format stream-json --force --trust --workspace <cwd>
  [--model <model>]
  [--approve-mcps]
  [--resume <chatId>]    // Task 3b でのセッション再開時
  "<prompt>"             // 最後の位置引数としてプロンプトを渡す
```

プロンプトは**位置引数**として渡す（CLI ヘルプ: `Arguments: prompt - Initial prompt for the agent`）。stdin は監視されない。

注意:
- `--mcp-config` は使えない。MCP は `<workspace>/.cursor/mcp.json` ファイルで事前設定が必要
- `--resume` / `--continue` は 1-shot モードでは実質使えない（Task 3b で別プロセス起動方式に使用）
- stdin は不使用（1-shot で終了するため）

**stdout パース**:

```typescript
function spawnCursorAgent(opts: CursorProcessOptions): {
  messages: AsyncIterable<Record<string, unknown>>;  // 生の JSONL（正規化前）
  child: ChildProcess;
  sessionId: Promise<string>;  // system init から抽出
}
```

- `readline.createInterface({ input: child.stdout })` で行単位 JSON パース
- `type: "system" subtype: "init"` から `session_id` を抽出
- `type: "result"` をプロセス終了のシグナルとして使用

**チェックリスト**:
- [ ] `getCursorAgentPath()` 実装 + テスト
- [ ] `spawnCursorAgent()` 実装
- [ ] stdout の AsyncIterable 変換
- [ ] session_id 抽出
- [ ] spawn 引数構築のテスト
- [ ] !! GATE: テスト全パス

### Task 3a: runCursor 読取専用 MVP

セッション作成 → Cursor プロセス起動 → 正規化 → パイプライン → サーバー送信。読取専用（モバイルからの入力なし）。

**File**: `packages/happy-cli/src/cursor/runCursor.ts`

**初回 prompt のフロー**:

リモートモードのため、初回プロンプトは**モバイルアプリから送信**される（`runAcp.ts` / `claudeRemoteLauncher.ts` と同パターン）。

```
1. runCursor() 起動 → セッション作成 → サーバー接続
2. session.onUserMessage() でモバイルからのメッセージ待機
3. メッセージ受信 → spawnCursorAgent({ prompt: message, ... })
4. Cursor プロセスの stdout を処理
5. プロセス終了 → Task 3a では exit（Task 3b では 2 に戻る）
```

**パイプライン**:

```
Cursor stdout (JSONL)
  → normalizeCursorMessage()     [Cursor 独自形式 → Claude 互換 SDKMessage]
  → sdkToLogConverter.convert()   [SDKMessage → RawJSONLines]
  → sessionProtocolMapper()       [RawJSONLines → SessionEnvelope[]]
  → session.sendSessionProtocolMessage()  [サーバーへ送信]
```

**セッション作成**（`runAcp.ts` パターン踏襲）:

```typescript
const api = await ApiClient.create(opts.credentials);
const settings = await readSettings();
await api.getOrCreateMachine({ machineId: settings.machineId, metadata: initialMachineMetadata });

const { state, metadata } = createSessionMetadata({
  flavor: 'acp',  // BackendFlavor に 'cursor' がないため 'acp' を使用
  machineId: settings.machineId,
  startedBy: opts.startedBy,
  sandbox: settings.sandboxConfig,
});
const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

let session: ApiSessionClient;
const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
  api, sessionTag, metadata, state, response,
  onSessionSwap: (newSession) => { session = newSession; },
});
session = initialSession;
```

**Happy MCP サーバー**:

```typescript
// Happy MCP サーバー: MVP では起動しない（--mcp-config フラグなし、.cursor/mcp.json 動的書き換えは将来タスク）
// MVP で欠けるもの: change_title ツール（セッションタイトル変更）。テキスト/ツール表示には影響なし
// 将来: <workspace>/.cursor/mcp.json に Happy MCP の設定を動的追加 → プロセス終了時に復元するヘルパー
```

**keepAlive**:

```typescript
let thinking = false;
session.keepAlive(thinking, 'remote');
const keepAliveInterval = setInterval(() => {
  session.keepAlive(thinking, 'remote');
}, 2000);
```

thinking 状態の更新:
- `type: "thinking" subtype: "delta"` を受信 → `thinking = true`、即時 `session.keepAlive(true, 'remote')`
- `type: "thinking" subtype: "completed"` を受信 → `thinking = false`、即時 `session.keepAlive(false, 'remote')`

**メッセージ処理ループ**:

```typescript
const normalizer = createCursorNormalizer();
const sdkToLogConverter = new SDKToLogConverter({ sessionId, cwd, version }, new Map());
const mapperState: ClaudeSessionProtocolState = { currentTurnId: null };

for await (const rawMsg of cursorMessages) {
  // thinking 状態更新（keepAlive 用）
  if (rawMsg.type === 'thinking') {
    const nextThinking = rawMsg.subtype === 'delta';
    if (thinking !== nextThinking) {
      thinking = nextThinking;
      session.keepAlive(thinking, 'remote');
    }
  }

  // 正規化
  const sdkMessages = normalizer.normalize(rawMsg);

  for (const sdkMsg of sdkMessages) {
    try {
    // SDK → Log 変換
    const logMessage = sdkToLogConverter.convert(sdkMsg);
    if (!logMessage) continue;

    // Log → SessionEnvelope 変換
    const { envelopes } = mapClaudeLogMessageToSessionEnvelopes(logMessage, mapperState);

    // サーバー送信
    for (const envelope of envelopes) {
      session.sendSessionProtocolMessage(envelope);
    }
    } catch (e) {
      logger.debug('[cursor] Failed to process message:', e);
      // 1メッセージの変換失敗でループ全体を停止しない
    }
  }
}

// プロセス終了時: バッファされた thinking をフラッシュ
const remaining = normalizer.flush();
for (const sdkMsg of remaining) { /* 同上の処理 */ }
```

**ツールコール追跡 + 中断処理**（`claudeRemoteLauncher.ts` L416-423 パターン）:

```typescript
const ongoingToolCalls = new Map<string, string | null>();

// tool_call started で追加
// tool_call completed で削除

// finally 内で:
for (const [callId] of ongoingToolCalls) {
  const interrupted = sdkToLogConverter.generateInterruptedToolResult(callId, null);
  if (interrupted) {
    const { envelopes } = mapClaudeLogMessageToSessionEnvelopes(interrupted, mapperState);
    for (const env of envelopes) session.sendSessionProtocolMessage(env);
  }
}
```

**abort / kill session**:

```typescript
session.rpcHandlerManager.registerHandler('abort', async () => {
  child.kill('SIGTERM');
});
registerKillSessionHandler(session.rpcHandlerManager, async () => {
  shouldExit = true;
  child.kill('SIGTERM');
});
```

**daemon 通知**:

```typescript
if (response) {
  try { await notifyDaemonSessionStarted(response.id, metadata); }
  catch (e) { logger.debug('[cursor] Failed to notify daemon:', e); }
}
```

**クリーンアップ（finally）**:

| 順序 | 処理 |
|------|------|
| 1 | `clearInterval(keepAliveInterval)` |
| 2 | `reconnectionHandle?.cancel()` |
| 3 | ツールコール中断処理 |
| 4 | `happyServer?.stop()` (MVP では起動しないため条件付き) |
| 5 | `session.updateMetadata({ lifecycleState: 'archived', ... })` |
| 6 | `session.sendSessionDeath()` |
| 7 | `await session.flush()` |
| 8 | `await session.close()` |

**チェックリスト**:
- [ ] セッション作成（createSessionMetadata, getOrCreateSession, setupOfflineReconnection + onSessionSwap）
- [ ] Happy MCP サーバー: MVP では**起動しない**（change_title 欠落は許容。将来 .cursor/mcp.json 動的書き換えで対応）
- [ ] keepAlive（初回 + 2秒間隔 + thinking 連動）
- [ ] Cursor プロセス起動 + 正規化パイプライン接続
- [ ] ツールコール追跡 + 中断処理
- [ ] abort / kill session ハンドラ
- [ ] daemon 通知
- [ ] クリーンアップ（finally 全 8 ステップ）
- [ ] stderr ハンドリング（デバッグログ出力）
- [ ] `result` イベントの `is_error: true` 時のエラーログ出力
- [ ] !! GATE: `happy cursor` で起動 → ターミナルで stdout ストリーム確認（AI 実行）
- [ ] !! HG-1: ユーザー事前作業（Step 1〜4）完了待ち → `happy auth status` + `happy-agent auth status` で確認
- [ ] !! GATE: iOS アプリで text + tool_call が表示される（HG-2 でユーザー目視確認）

### Task 3b: モバイルからの入力送信（双方向化）

`--print` モードが 1-shot のため、モバイルからのメッセージ受信時に `--resume <chatId>` で新プロセスを起動する方式。

**前提**: Task 3a の `spawnCursorAgent()` が `--resume` 対応済みであること。

**フロー**:

```
1. 初回プロンプト → cursor-agent プロセス起動 → 完了（exit）
2. session.onUserMessage() でモバイルからメッセージ受信
3. --resume <sessionId> で新プロセス起動
4. 正規化パイプラインに接続
5. 完了（exit）
6. 2 に戻る
```

**MessageQueue2 パターン**（`runAcp.ts` 踏襲）:

```typescript
const messageQueue = new MessageQueue2<{ model?: string }>((mode) => hashObject(mode));

session.onUserMessage((message) => {
  if (!message.content.text) return;
  messageQueue.push(message.content.text, {});
});

while (!shouldExit) {
  const batch = await messageQueue.waitForMessagesAndGetAsString(abortController.signal);
  if (!batch) break;

  // プロセスごとに normalizer を再作成（前プロセスの thinking バッファ混入を防止）
  const normalizer = createCursorNormalizer();

  // 新しい Cursor プロセスを --resume で起動
  const { messages, child } = spawnCursorAgent({
    prompt: batch.message,
    cwd: workspacePath,
    resume: cursorSessionId,
    force: true,
  });

  // 正規化パイプラインに接続して処理
  await processMessages(messages, normalizer, sdkToLogConverter, mapperState, session);

  // abort 後に次の turn 待機を可能にするため AbortController をリセット
  abortController = new AbortController();
}
```

**チェックリスト**:
- [ ] `session.onUserMessage()` → `messageQueue.push()`
- [ ] メッセージ待機ループ（MessageQueue2 + AbortSignal）
- [ ] `--resume` での新プロセス起動
- [ ] セッションID の引き継ぎ
- [ ] abort / 再起動時の状態管理
- [ ] !! GATE: モバイルからメッセージ送信 → Cursor が応答 → 結果がモバイルに表示

### Task 4: CLI エントリポイント登録

**File**: `packages/happy-cli/src/index.ts`

`codex` サブコマンドと同一パターンで `cursor` を追加。

```typescript
} else if (subcommand === 'cursor') {
    try {
      const { runCursor } = await import('@/cursor/runCursor');
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      const cursorArgs = extractNoSandboxFlag(args.slice(1));
      for (let i = 0; i < cursorArgs.args.length; i++) {
        if (cursorArgs.args[i] === '--started-by') {
          startedBy = cursorArgs.args[++i] as 'daemon' | 'terminal';
        }
      }
      const { credentials } = await authAndSetupMachineIfNeeded();
      await runCursor({ credentials, startedBy, noSandbox: cursorArgs.noSandbox });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) { console.error(error) }
      process.exit(1)
    }
    return;
}
```

**チェックリスト**:
- [ ] `index.ts` に `cursor` サブコマンド追加
- [ ] `happy cursor` でビルド + 起動確認
- [ ] !! GATE: ビルドパス

### Task 5: E2E 動作検証

**AI が実行（ターミナル）:**
- [ ] `happy cursor` でセッション起動 → stdout ストリーム確認
- [ ] セッション終了時のクリーンアップ確認（プロセス exit、メタデータ archived）
- [ ] `happy-agent list --active` でセッション表示確認
- [ ] `happy-agent history <session-id>` でメッセージ履歴確認（テキスト、thinking、tool_call）
- [ ] `happy-agent status <session-id>` でライブ状態確認

**!! HG-2: ユーザー目視確認（物理デバイス）:**
- [ ] iOS アプリでセッション一覧に表示されるか
- [ ] テキスト出力の表示
- [ ] thinking の表示（バッファリング → 1メッセージ）
- [ ] editToolCall（ファイル書き込み）の表示
- [ ] shellToolCall（コマンド実行）の表示
- [ ] → ユーザーが OK / NG を報告

**!! HG-3: ユーザー操作確認（Task 3b 依存、物理デバイス）:**
- [ ] モバイルからメッセージ送信 → Cursor が `--resume` で応答
- [ ] 複数回のやり取り（3ターン以上）
- [ ] abort（モバイルから中断）
- [ ] → ユーザーが OK / NG を報告

## Technical Details

### Cursor プロセスのバイナリ配置

```
~/.local/bin/cursor          # シム（IDE 検出 → agent フォールバック）
~/.local/bin/agent           # symlink → cursor-agent 実体
~/.local/share/cursor-agent/versions/<version>/cursor-agent  # 実体（bash → node index.js）
```

### MCP 設定（--mcp-config なし）

Cursor は以下のファイルから MCP 設定を読み込む:
- **グローバル**: `~/.cursor/mcp.json`
- **プロジェクト**: `<workspace>/.cursor/mcp.json`
- **ディスカバリ**: `.mcp.json`, `mcp.json`

Happy MCP サーバーを接続するには、ワークスペースの `.cursor/mcp.json` に設定を書き込む必要がある。`runCursor` の初期化時に動的に追加し、終了時に元に戻すヘルパーを検討。

### Session Flavor

`BackendFlavor` 型は `'claude' | 'codex' | 'gemini' | 'opencode' | 'acp'`。`'cursor'` は存在しない。初期実装では `'acp'` を使用。将来的に upstream が `'cursor'` を追加した場合は移行。

### --print モードの 1-shot 挙動

Cursor Agent は `--print` モードでプロンプトを処理後、`result` イベントを出力して即座に exit 0 で終了する。stdin は監視しない。双方向化（Task 3b）は、メッセージ受信のたびに `--resume <chatId>` で新プロセスを起動する方式で実現。

## Fork Maintenance Policy

- **upstream への PR は出さない** — 独自拡張として維持
- **shared module は import のみ、変更しない**
- upstream の変更取り込み: 2週間に1回目安で `git fetch upstream && git rebase upstream/main`
- コンフリクトリスクが高い箇所: `index.ts`（サブコマンド追加）、`apiSession.ts`（型変更時）
- `src/cursor/` ディレクトリに隔離することで upstream 変更との衝突を最小化
- **公式サーバー接続は自己責任**: フォーク版 CLI で `happy.engineering` に接続する。MIT ライセンスで改変は許可されているが、不正なデータ送信や過剰な負荷はアカウント制限のリスクがある。開発初期はテスト用アカウント推奨。セルフホスト（`Dockerfile` 提供あり）への移行も選択肢

## Post-Completion

**手動検証:**
- `happy cursor` → プロンプト実行 → iOS アプリで進捗確認
- ツール呼び出し込みのタスク（ファイル編集、コマンド実行）の表示
- モバイルからの指示送信（--resume 方式）
- `happy-agent` コマンドでの状態確認

**将来の拡張:**
- ACP 対応（Cursor が ACP サポートした場合）
- `--cloud` モード対応
- `--worktree` を活用した分離実行
- daemon 経由のバックグラウンドセッション
- thinking delta のリアルタイムストリーミング（バッファリングではなく即時送信）
- `--stream-partial-output` 対応（当面 OFF）
