# claudeRemoteLauncher.ts 抽出レポート

Cursor Agent Runner 実装に必要な情報を抽出した結果。

---

## 1. SDKToLogConverter の使い方

### コンストラクタ引数

```111:116:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());
```

- **第1引数**: `ConversionContext`（`parentUuid` を除く）
  - `sessionId`: セッションID（初期値は `session.sessionId` または `'unknown'`）
  - `cwd`: 作業ディレクトリ
  - `version`: バージョン（オプション）
- **第2引数**: `permissionHandler.getResponses()` の Map（オプション）
  - ツール結果に permissions フィールドを付与する際の参照元

### convert() の呼び出しパターン

```202:203:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
        const logMessage = sdkToLogConverter.convert(msg);
        if (logMessage) {
```

- **呼び出しタイミング**: `onMessage` コールバック内で、SDK メッセージをログ形式に変換するたびに呼ぶ
- **入力**: `SDKMessage`（user/assistant/system/result）
- **戻り値**: `RawJSONLines | null`（system の一部は null、result は null）
- **注意**: `convert()` 内で `lastUuid` と `sidechainLastUUID` が更新される（状態を持つ）

### resetParentChain() の使いどころ

```306:308:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
```

- **呼び出しタイミング**: `session.sessionId !== previousSessionId` のとき（新セッション開始時）
- **目的**: 親子関係の追跡をリセットし、新しい会話の開始を明示する
- **副作用**: `lastUuid` と `context.parentUuid` を null に

### その他のメソッド

- **updateSessionId(sessionId)**: `onSessionFound` コールバック内で呼ぶ（364行目）
- **generateInterruptedToolResult(toolCallId, parentToolCallId)**: 後述
- **convertSidechainUserMessage(toolUseId, content)**: Task ツールのサイドチェーン用（274行目付近）

### Cursor Agent Runner での所見

- SDKToLogConverter は **状態を持つ** ため、セッションごとに1インスタンスを維持する
- `sessionId` は `onSessionFound` で更新されるため、初期値は `'unknown'` でも問題ない
- Cursor の Agent は plan mode を持たないため、`convertSidechainUserMessage` の Task ツール対応は要検討（Cursor 側でも Task 相当があるか）

---

## 2. OutgoingMessageQueue の使い方

### コンストラクタ引数

```101:104:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
    );
```

- **送信関数**: `(logMessage) => void` で、ログ形式メッセージをクライアントに送る関数

### enqueue() の引数パターン

**通常（即時送信）:**

```269:271:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }
```

**delay 付き tool call（トップレベルのみ）:**

```255:266:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds
                        });
                        return; // Don't queue again below
                    }
```

- **delay**: 250ms で送信を遅延
- **toolCallIds**: このメッセージに含まれる tool_use の ID 配列
- **サイドチェーン**（`parent_tool_use_id` あり）は delay なしで即時送信

### releaseToolCall のトリガー

```106:108:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });
```

```159:164:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);

                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
```

- **Permission リクエスト時**: ユーザーが許可/拒否を決める前に、該当ツールコールのメッセージを即時送信
- **tool_result 受信時**: 同じ tool_use_id の遅延メッセージを即時送信

### flush() / destroy() のタイミング

```316:318:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
```

- **タイミング**: `claudeRemote` の `finally` ブロック内（1 turn 終了時）
- **flush()**: タイマーを全てクリアし、遅延中のメッセージを即時送信
- **destroy()**: タイマーをクリアしてリソース解放

### Cursor Agent Runner での所見

- Cursor の送信先が `session.client.sendClaudeSessionMessage` と異なる場合、コンストラクタの送信関数を差し替える
- delay 250ms は「許可 UI の表示前にメッセージを送らない」ための UX 配慮。Cursor では許可 UI の有無に応じて要検討
- `flush()` → `destroy()` の順は必須

---

## 3. PermissionHandler との連携

### setOnPermissionRequest

```106:108:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });
```

- **タイミング**: 初期化時（`PermissionHandler` 作成後）
- **目的**: 許可リクエスト発生時に `OutgoingMessageQueue` の遅延メッセージを即時解放

### handleToolCall

```332:334:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
```

- **タイミング**: `claudeRemote` の `canCallTool` に渡す
- **役割**: ツール実行前の許可チェック

### getResponses

```111:116:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());
```

```213:239:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                        const responses = permissionHandler.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };
                            // ...
```

- **タイミング**: `SDKToLogConverter` のコンストラクタと、`tool_result` の permissions 付与時
- **注意**: `getResponses()` は同一 Map インスタンスを返す（参照渡し）

### handleModeChange

```339:356:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                            permissionHandler.handleModeChange(p.mode.permissionMode);
                            return p;
                        }
                        // ...
                            permissionHandler.handleModeChange(mode.permissionMode);
                            return {
```

- **タイミング**: `nextMessage` の戻り値で、新しいメッセージの `mode.permissionMode` が渡されるたび
- **役割**: 許可モード（default / acceptEdits / bypassPermissions / plan）の更新

### reset

```309:309:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                permissionHandler.reset(); // Reset permissions before starting new session
```

```326:326:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                permissionHandler.reset();
```

```334:334:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
        permissionHandler.reset();
```

- **タイミング**:
  1. 新セッション開始時（`isNewSession` のとき）
  2. `claudeRemote` の `finally` ブロック内（1 turn 終了時）
  3. 全体の `finally` ブロック内（クリーンアップ時）

### Cursor Agent Runner での所見

- Cursor Agent では PermissionHandler 相当の仕組みがない可能性が高い
- その場合、`canCallTool` は常に allow を返すか、Cursor 側の API に委譲する
- `session.client.rpcHandlerManager.registerHandler('permission', ...)` の登録は PermissionHandler 内部で行われる（setupClientHandler の 378 行目付近）— Cursor では RPC がないため、PermissionHandler 自体を簡略化またはスキップする必要がある

---

## 4. プロセスライフサイクル

### claudeRemote() 呼び出しのパターン

```303:392:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
        while (!exitReason) {
            logger.debug('[remote]: launch');
            // ...
            const remoteResult = await claudeRemote({
                sessionId: session.sessionId,
                path: session.path,
                allowedTools: session.allowedTools ?? [],
                // ...
                signal: abortController.signal,
            });
```

- **ループ**: `while (!exitReason)` で複数 turn を繰り返す
- **1 turn の流れ**: `claudeRemote` が 1 メッセージを処理して完了 → `onReady` が呼ばれる → 次の `nextMessage` で待機

### exitReason の管理

```69:69:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    let exitReason: 'switch' | 'exit' | null = null;
```

```44:52:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // ...
                if (!exitReason) {
                    exitReason = 'switch';
                }
```

```396:396:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    return exitReason || 'exit';
```

- **設定箇所**: Ctrl-C（`onExit`）、`doSwitch`、`doAbort`
- **用途**: ループ終了条件と戻り値の決定

### AbortController の使い方

```73:77:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }
```

```319:321:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
```

- **1 turn ごとに新しい AbortController を作成**
- **abort()**: 現在の turn を abort し、`abortFuture.resolve` まで待つ
- **claudeRemote** の `signal` に渡す

### Cursor Agent Runner での所見

- Cursor では「複数 turn のループ」と「switch / exit」の概念が異なる可能性がある
- 1 回の Agent 実行で 1 turn 相当なら、`while` ループは不要になる
- AbortController は Cursor のキャンセル API と連携する必要がある

---

## 5. ツールコール中断処理

### ongoingToolCalls の追跡方法

```120:121:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    let planModeToolCalls = new Set<string>();
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
```

**追加（assistant の tool_use）:**

```144:154:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                    }
                }
            }
        }
```

**削除（user の tool_result）:**

```156:159:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);
```

### generateInterruptedToolResult の呼び出し

```408:415:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();
```

- **タイミング**: `claudeRemote` の `finally` ブロック内（turn 終了時）
- **目的**: 完了していない tool 呼び出しに対して、中断用の tool_result を送信

### Cursor Agent Runner での所見

- 中断時には、未完了の tool_call に対して `generateInterruptedToolResult` を送る必要がある
- Cursor の Agent が同様のログ形式を期待するかは要確認

---

## 6. keepAlive / onReady

### session.client.closeClaudeSessionTurn

```385:386:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    onReady: () => {
                        session.client.closeClaudeSessionTurn('completed');
```

```401:401:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    session.client.closeClaudeSessionTurn('cancelled');
```

```407:407:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    session.client.closeClaudeSessionTurn('failed');
```

- **onReady 内**: `closeClaudeSessionTurn('completed')` — turn 正常完了時
- **abort 時**: `closeClaudeSessionTurn('cancelled')`
- **catch 時**: `closeClaudeSessionTurn('failed')`

### sendSessionEvent

```374:376:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
```

```402:402:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
```

```408:408:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    session.client.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
```

- **onCompletionEvent**: 完了メッセージ（例: /clear の "Context was reset"）を送信
- **abort 時**: "Aborted by user"
- **catch 時**: "Process exited unexpectedly"

### onReady の追加処理

```385:387:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    onReady: () => {
                        session.client.closeClaudeSessionTurn('completed');
                        if (!pending && session.queue.size() === 0) {
                            session.api.push().sendToAllDevices(
```

- **push 通知**: 待機中メッセージがなく、キューが空のときに「ready」通知を送る

### Cursor Agent Runner での所見

- Cursor のセッション API に `closeClaudeSessionTurn` / `sendSessionEvent` 相当があるかは要確認
- ない場合は、Cursor の状態遷移 API にマッピングする必要がある

---

## 7. セッションID管理

### previousSessionId の追跡

```301:318:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
        let previousSessionId: string | null = null;
        while (!exitReason) {
            // ...
            const isNewSession = session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset();
                sdkToLogConverter.resetParentChain();
                // ...
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                // ...
            }
            previousSessionId = session.sessionId;
```

- **目的**: セッションIDの変更検出（モード変更などで sessionId が変わらない場合も考慮）
- **参照**: [Issue #143](https://github.com/anthropics/happy-cli/issues/143)

### sdkToLogConverter.updateSessionId

```363:367:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                    },
```

- **タイミング**: `claudeRemote` 内で `onSessionFound` が呼ばれたとき（SDK が新セッションを検出したとき）

### session.onSessionFound

- **役割**: セッションオブジェクト側で sessionId を更新する

### Cursor Agent Runner での所見

- Cursor のセッションID管理がどの程度必要かは、Cursor の API に依存する
- ログ形式で sessionId を送る必要があるなら、`updateSessionId` と `previousSessionId` のロジックは維持する

---

## 8. planMode ハック

### planModeToolCalls の追跡

```119:119:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
    let planModeToolCalls = new Set<string>();
```

```130:141:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                        logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                        planModeToolCalls.add(c.id! as string);
                    }
                }
            }
        }
```

### planMode ハックの適用箇所

```173:199:packages/happy-cli/src/claude/claudeRemoteLauncher.ts
        const logMessage = sdkToLogConverter.convert(msg);
        // ...
        // Hack plan mode exit
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                msg = {
                    ...umessage,
                    message: {
                        ...umessage.message,
                        content: umessage.message.content.map((c) => {
                            if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                if (c.content === PLAN_FAKE_REJECT) {
                                    // ...
                                    return {
                                        ...c,
                                        is_error: false,
                                        content: 'Plan approved',
                                        mode: c.mode
                                    }
                                } else {
                                    return c;
                                }
                            }
                            return c;
                        })
                    }
                }
            }
        }
```

- **目的**: `exit_plan_mode` の tool_result が `PLAN_FAKE_REJECT` の場合、`content` を "Plan approved" に書き換えて送信する

### Cursor Agent Runner での所見

- **Cursor では plan mode は不要** と想定
- **除外する箇所**:
  1. `planModeToolCalls` の Set とその追跡コード（130–141 行目）
  2. plan mode ハックの `msg` 変換ロジック（173–199 行目）
  3. `PermissionHandler` 内の `exit_plan_mode` / `ExitPlanMode` 特別処理（permissionHandler.ts 87–100 行目）
  4. `PLAN_FAKE_REJECT` / `PLAN_FAKE_RESTART` の import と使用

- これらを削除しても、通常の tool 呼び出しには影響しない

---

## まとめ

| コンポーネント | Cursor Agent Runner での扱い |
|--------------|---------------------------|
| SDKToLogConverter | 維持。送信先は差し替え可能。 |
| OutgoingMessageQueue | 維持。送信関数と delay の要否を検討。 |
| PermissionHandler | 簡略化またはスキップ。許可 UI の有無に依存。 |
| プロセスライフサイクル | 1 turn のみなら `while` ループは不要。 |
| ツールコール中断 | 維持。Cursor のログ形式に合わせる。 |
| keepAlive / onReady | Cursor の API にマッピング。 |
| セッションID管理 | Cursor のセッション API に合わせて要検討。 |
| planMode ハック | 削除。 |
