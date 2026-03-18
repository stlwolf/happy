# Cursor Agent Runner v2 — 機能拡張・課題一覧（Draft）

## ステータス: Draft（優先度・スコープ未確定）

## 背景

PR #3 で Cursor Agent Runner の MVP が完成し main にマージ済み。
以下は E2E 検証・Copilot レビュー・運用中に発見された課題と機能拡張の候補。

---

## 機能拡張

### E1: モデル/モード選択の対応

**概要**: アプリの UI にモデル選択・モード選択ボタンが表示されるが、`runCursor.ts` が `message.meta` を無視しているため選択が反映されない。

**現状**:
- `onUserMessage` が `message.meta.model` / `message.meta.permissionMode` を読み取っていない
- `MessageQueue2` の型が `Record<string, never>`（空）でモード情報を持たない
- `spawnCursorAgent` に model / mode を渡していない
- `flavor: 'claude'` のため、Claude 用ハードコード選択肢が表示される

**Cursor Agent CLI が対応するオプション**:
- `--model <model>` — モデル指定（gpt-5, sonnet-4 等）
- `--mode plan|ask` — plan モード / read-only
- `--force` / `--yolo` — パーミッション制御

**必要な変更**:
1. `onUserMessage` で `meta.model` と `meta.permissionMode` を読み取り
2. `MessageQueue2` の型を `{ permissionMode?, model? }` に拡張
3. `spawnCursorAgent` に model を渡す
4. `buildSpawnArgs` で permissionMode → `--mode` / `--yolo` マッピング追加
5. （任意）`flavor: 'cursor'` 導入 + アプリに Cursor 用選択肢追加

**対応コスト**: 中（CLI 側のみなら小、flavor 導入含むと中）

**参考**: `runCodex.ts` L167-193, `runClaude.ts` L263-378, `runGemini.ts` L211-284

---

### E2: クロスプロセス resume

**概要**: `happy cursor` プロセスを再起動すると、Cursor Agent のセッション ID がメモリ上のみのため文脈が失われる。

**現状**:
- `cursorSessionId` は `runCursor.ts` のローカル変数
- 同一プロセス内では `--resume <id>` で文脈維持が動作確認済み
- プロセス終了 → 再起動で `cursorSessionId` が消える

**必要な変更**:
1. `cursorSessionId` をファイルに永続化（`~/.happy/cursor-session.json` 等）
2. `runCursor` 起動時に永続化ファイルから復元
3. セッション終了時にファイルをクリア
4. Happy セッション ID との紐付けも必要か検討

**対応コスト**: 小

---

## 既知の課題

### B1: `sendLegacyLogMessage` にリトライ/再送なし

**概要**: `socket.emit` で直接送信しており、ソケット切断時にメッセージがサイレントに失われる。

**背景**: App Store 版の feature flag (`EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND` OFF) 互換のため、意図的に `type: 'output'` 形式で socket.emit を使用。`enqueueMessage` は session protocol 形式のため使用不可。

**対処方針**: アプリが session protocol に完全移行した段階で `enqueueMessage` 経由に切り替え。それまでは受容。

**対応コスト**: 小（移行時）

---

### B2: `sendLegacyLogMessage` に `localId` なし

**概要**: 再接続時のメッセージ重複排除（サーバー側 dedup）が効かない。

**対処方針**: `localId: randomUUID()` を追加するだけ。B1 とは独立して対応可能。

**対応コスト**: 極小

---

### B3: abort がセッション終了になる

**概要**: アプリの中断ボタン押下で abort RPC が2回連続発火し、2回目で `MessageQueue2 Wait aborted` → socket close → プロセス終了。

**調査結果**:
- 1回目の abort は正常（activeChild を SIGTERM、abortController.abort()）
- 2回目の abort が MessageQueue の wait を中断し、ループが `break` → finally でセッション終了

**対処方針**: アプリ側 UI の問題か、CLI 側で abort 後の再待機ロジックを見直すか要調査。

**対応コスト**: 要調査

---

### B4: Copilot 指摘未対応（スコープ外）

- `patches/fix-pglite-prisma-bytes.cjs` — パッチがサイレント失敗する可能性（警告追加）
- `scripts/postinstall.cjs` — パッチ throw でインストール全体が失敗（try/catch 追加）

**対処方針**: 別 Issue で対応。本機能のスコープ外。

---

## 将来の拡張（キックオフ計画で定義済み）

以下は `docs/plans/cursor-agent-runner.md` の Post-Completion セクションで定義された拡張候補。

### F1: ACP 対応

Cursor が ACP（Agent Client Protocol）をサポートした場合、`happy acp cursor` で起動可能にする。正規化レイヤーが不要になり、`KNOWN_ACP_AGENTS` に 1 行追加するだけで済む。

**前提条件**: cursor-agent に `--experimental-acp` 等の ACP フラグが追加されること。2026-03-17 時点では非対応（検証済み）。

**対応コスト**: 極小（ACP 対応されれば）

---

### F2: `--cloud` モード対応

Cursor Agent の `--cloud` フラグでクラウド実行を利用する。出力形式がローカルと同一か、別のストリーミング方式になるか未検証。

**未確認事項**: cloud モード時の stream-json 出力がローカルと同一フォーマットか

**対応コスト**: 要調査

---

### F3: `--worktree` を活用した分離実行

Cursor Agent の `--worktree` オプションで git worktree を作成し、メインブランチに影響を与えずに作業を実行する。

**CLI オプション**: `-w, --worktree [name]`, `--worktree-base <branch>`, `--skip-worktree-setup`

**対応コスト**: 小（`buildSpawnArgs` にオプション追加）

---

### F4: daemon 経由のバックグラウンドセッション

`happy daemon` と連携し、`happy cursor` をバックグラウンドで動かす。現在は `notifyDaemonSessionStarted` を呼んでいるが、daemon からのセッション起動は未実装。

**参考**: `runAcp.ts` の `isDaemonRunningCurrentlyInstalledHappyVersion()` + `spawnHappyCLI(['daemon', 'start-sync'])` パターン

**対応コスト**: 中

---

### F5: thinking delta のリアルタイムストリーミング

現在は thinking delta をバッファに蓄積し `completed` 時に 1 メッセージとして emit するが、長時間の thinking（30秒以上）ではテキストが見えない。delta を一定間隔（例: 200ms）で集約して即時送信する方式に変更する。

**トレードオフ**: 各 delta が個別の SessionEnvelope になるとモバイルアプリの描画性能に影響する可能性（arena-compare で Opus が指摘）。バッファリング間隔のチューニングが必要。

**対応コスト**: 中

---

### F6: `--stream-partial-output` 対応

Cursor Agent の `--stream-partial-output` フラグを有効にすると、テキスト応答が差分（delta）として逐次出力される。現在は OFF（当面 OFF の方針）。

**リスク**: ON にすると `assistant` メッセージが差分形式になり、正規化レイヤーの pass-through が壊れる可能性（arena-compare で GPT が指摘）。有効化時は重複/順序問題の検証が必要。

**対応コスト**: 要調査

---

## 調査が必須な追加課題

実装・E2E 検証中に発見された、将来の安定運用に影響する課題。

### I1: `happy-agent auth login` の 404 エラー

**発見**: E2E 検証時。`happy-agent auth login` が `/v1/auth/account/request` に POST して 404 が返る。

**影響**: Task 5 の CLI 検証コマンド（`happy-agent list`, `happy-agent history`, `happy-agent status`）が使えない。現在はアプリの目視確認で代替。

**状態**: **未解決（I3 と同根の可能性あり）**

**調査項目**:
- `HAPPY_SERVER_URL=https://api.happy-servers.com` を設定した状態で `happy-agent auth login` を再試行 → これで解消すれば I3 と同根
- `happy-agent` が独自にサーバー URL を持っている場合、`happy-agent` 側の設定確認
- サーバーの `/v1/auth/account/request` エンドポイントが存在するか（API バージョン差異の可能性）

---

### I2: App Store 版の session protocol feature flag

**発見**: E2E 検証時。App Store 版アプリの `EXPO_PUBLIC_ENABLE_SESSION_PROTOCOL_SEND` が OFF のため、`type: 'session'` 形式のメッセージが silent DROP される。

**状態**: **回避策実装済み**（`sendLegacyLogMessage` コミット済み）。根本解決は将来のアプリ側フラグ ON 待ち。

**残りの調査項目**:
- Expo OTA アップデートでフラグが変更される可能性
- 開発版アプリ（TestFlight / Expo Dev Client）でフラグ ON の動作確認
- `sendLegacyLogMessage` → `sendSessionProtocolMessage` への移行パスと切り替え条件

---

### I3: サーバー URL デフォルト値の不一致

**発見**: E2E 検証時。`packages/happy-cli/src/configuration.ts` L32 で `HAPPY_SERVER_URL` 未設定時のデフォルトが `https://api.cluster-fluster.com`（404 を返す）。正しくは `https://api.happy-servers.com`。

**状態**: **原因特定・回避策確立済み**（`export HAPPY_SERVER_URL=https://api.happy-servers.com` で解決）。永続化は未対応。

**残りの調査項目**:
- `.envrc` や `~/.happy/config` で永続化する方法
- upstream のデフォルト値更新の有無（rebase 時に解消される可能性）

---

### I4: origin/main の `happy claude` / `happy codex` もモバイル表示されない

**発見**: HG-1.5（Claude Code で正常動作体験）の実施時。フォーク版の `happy claude` を実行しても feature flag 問題（I2 と同根）でアプリに表示されない。

**状態**: **原因確定済み（I2 と同根）**。`sendLegacyLogMessage` 対応を claude/codex 側に適用すれば解消するが、フォーク独自改変の範囲が広がるため優先度低。

**代替手段**: npm 0.13.0 グローバル版で HG-1.5 を実施済み（動作確認OK）

---

## プラン品質の改善（プロセス課題）

### P1: 消費者スキーマとの突合チェック

**発生した問題**: アプリの Zod スキーマが `model: z.string()` を必須とするが、Cursor 正規化メッセージに `model` が欠落。E2E まで発覚しなかった。

**教訓**:
- 「既存パイプラインを再利用」の判断時に、消費者のスキーマとの突合が欠落
- Claude/Codex では SDK が暗黙的に `model` を付与するため問題にならなかった
- 新しい入力源は暗黙契約を満たさないリスクがある

**対処案**:
- プランレビューのチェックリストに「消費者スキーマとの突合」を追加
- 「既存パイプラインを再利用する場合、既存入力と新規入力のサンプルデータを比較し、差分フィールドを列挙」をプラン指示に含める
- 送信フォーマットがアプリの Zod スキーマを通るかの単体テスト追加を検討

---

## 参照

- Issue: [#1](https://github.com/stlwolf/happy/issues/1)
- PR (merged): [#3](https://github.com/stlwolf/happy/pull/3)
- キックオフ: `docs/plans/cursor-agent-runner.md`
- デバッグ記録: `docs/plans/cursor-agent-runner-debug-findings.md`
