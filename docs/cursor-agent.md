# Cursor Agent Integration

Use Cursor Agent CLI from your mobile device with end-to-end encryption.

## Overview

`happy cursor` wraps Cursor Agent CLI (`cursor agent --print --output-format stream-json`) and relays the session to Happy Coder's mobile/web app. You can monitor Cursor's progress, see tool calls, and send follow-up messages from your phone.

### How It Works

```
cursor-agent (local)  →  Happy Server (relay)  →  Happy App (iPhone/Web)
       ↑                                                  |
       └──────────── follow-up messages ──────────────────┘
```

1. `happy cursor` creates a Happy session and waits for a prompt from the mobile app
2. When you send a message from the app, it spawns `cursor-agent --print --output-format stream-json`
3. Cursor's output is normalized (Cursor uses a different format for tool calls and thinking) and sent to the server
4. The mobile app displays text, thinking status, and tool calls in real-time
5. For follow-up messages, a new `cursor-agent --resume` process is started

## Quick Start

### Prerequisites

- [Cursor](https://cursor.com/) installed with Pro or Business subscription
- [Happy Coder iOS app](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) or [Android app](https://play.google.com/store/apps/details?id=com.ex3ndr.happy) installed
- Node.js >= 20.0.0

### Setup

```bash
# 1. Clone and install
git clone https://github.com/stlwolf/happy.git
cd happy
yarn install

# 2. Set the server URL (required for fork)
export HAPPY_SERVER_URL=https://api.happy-servers.com

# 3. Authenticate with Happy
yarn cli auth login
# → Scan the QR code with the Happy mobile app

# 4. Start Cursor session
yarn cli cursor
```

### From Built Package

```bash
# If installed via packages/happy-cli
./packages/happy-cli/bin/happy.mjs cursor
```

## Usage

### Basic Usage

```bash
# Start a Cursor session (waits for prompt from mobile app)
happy cursor

# With environment variable for server URL
HAPPY_SERVER_URL=https://api.happy-servers.com happy cursor
```

### Workflow

1. Run `happy cursor` in your terminal
2. Open the Happy app on your phone
3. You'll see a new session in the session list
4. Tap the session and type your prompt
5. Watch Cursor work — text, thinking, and tool calls are displayed in real-time
6. Send follow-up messages as needed
7. Press Ctrl-C in the terminal to end the session

### Options

`happy cursor` inherits options from the CLI entry point:

- `--started-by daemon|terminal` — How the session was started (used by daemon)
- `--no-sandbox` — Disable sandbox restrictions

Cursor Agent options are configured internally:

| Option | Value | Notes |
|--------|-------|-------|
| `--print` | always | Non-interactive mode |
| `--output-format` | `stream-json` | NDJSON output |
| `--force` | always | Auto-approve all tools |
| `--trust` | always | Trust workspace |
| `--workspace` | cwd | Current working directory |
| `--approve-mcps` | always | Auto-approve MCP servers |
| `--resume` | on follow-up | Resume previous session for multi-turn |

## Architecture

### Normalization Layer

Cursor Agent CLI outputs a different format from Claude Code for tool calls and thinking:

| Cursor Event | Normalized To | Notes |
|---|---|---|
| `type:"system"` | pass-through | Identical format |
| `type:"user"` | pass-through | Identical format |
| `type:"thinking" subtype:"delta"` | buffered | Accumulated until completed |
| `type:"thinking" subtype:"completed"` | `assistant` + `content:[{type:"thinking"}]` | Emitted as single message |
| `type:"tool_call" subtype:"started"` | `assistant` + `content:[{type:"tool_use"}]` | Tool name inferred from oneOf field |
| `type:"tool_call" subtype:"completed"` | `user` + `content:[{type:"tool_result"}]` | Result stringified |
| `type:"assistant"` | pass-through | Identical format |
| `type:"result"` | dropped | Process exit signals completion |

### Tool Name Mapping

| Cursor tool_call field | Mapped name |
|---|---|
| `editToolCall` | `Write` |
| `shellToolCall` | `Shell` |
| (other) | Field name as-is |

### Pipeline

```
Cursor stdout (NDJSON)
  → normalizeCursorMessage()       [Cursor → Claude-compatible SDKMessage]
  → sdkToLogConverter.convert()     [SDKMessage → RawJSONLines]
  → sendLegacyLogMessage()          [RawJSONLines → server via socket.io]
```

### Files

| File | Purpose |
|---|---|
| `packages/happy-cli/src/cursor/normalizeCursorMessage.ts` | Cursor → Claude format normalization |
| `packages/happy-cli/src/cursor/cursorProcess.ts` | Binary detection, spawn, stdout parsing |
| `packages/happy-cli/src/cursor/runCursor.ts` | Main runner (session, pipeline, bidirectional, cleanup) |

## Known Limitations

- **No MCP bridge**: Cursor Agent CLI lacks `--mcp-config` flag. Happy MCP server (for `change_title` tool) is not connected. MCP configuration must be done via `~/.cursor/mcp.json` or `<workspace>/.cursor/mcp.json`
- **1-shot mode**: `cursor agent --print` exits after processing one prompt. Multi-turn conversation uses `--resume` to spawn a new process for each message
- **Legacy wire format**: Uses `type: 'output'` format (0.13.0 compatible) instead of session protocol (`type: 'session'`) due to App Store feature flag. This means turn management and subagent tracking from the session protocol are not available
- **Thinking is batched**: Thinking deltas are buffered and sent as a single message on completion, not streamed in real-time. The mobile app shows a "thinking" indicator via keepAlive
- **Session flavor**: Sessions appear as `acp` type in the app (no dedicated `cursor` flavor exists in the backend)

## Troubleshooting

### Server URL Error (404)

The default server URL in the codebase is `https://api.cluster-fluster.com` which returns 404. Always set:

```bash
export HAPPY_SERVER_URL=https://api.happy-servers.com
```

Add to your `~/.bashrc` or `~/.zshrc` for persistence, or create a `.envrc` in the repo root.

### Authentication Issues

```bash
# Check auth status
yarn cli auth status

# Re-authenticate
yarn cli auth login

# If QR code doesn't scan:
# - Select "Web Browser" option (happy auth only)
# - Enlarge terminal / increase font size
# - Ctrl-C and retry
```

### Cursor Agent Not Found

The CLI searches for cursor-agent in this order:

1. `HAPPY_CURSOR_PATH` environment variable
2. `~/.local/bin/agent`
3. `~/.local/share/cursor-agent/versions/*/cursor-agent`
4. `which cursor` (shim)

If not found, ensure Cursor is installed and `cursor agent --version` works.

### Messages Not Showing in App

- Verify `HAPPY_SERVER_URL` is set correctly
- Check that `happy auth login` completed successfully
- The App Store version requires legacy format — this is handled automatically by `sendLegacyLogMessage`
- Session should appear in the app's session list. If it does, but messages don't show, check terminal output for errors

## API Cost Warning

Each `cursor-agent` invocation consumes tokens from your Cursor Pro/Business subscription. For development and testing, use short prompts like `"say hello"` to minimize cost.
