/**
 * Normalizes Cursor Agent CLI stream-json messages into Claude-compatible SDKMessage format.
 * 
 * Cursor's stream-json output is partially compatible with Claude Code:
 * - system, user, assistant messages are identical schema (pass-through)
 * - tool_call uses a Cursor-specific format (type:"tool_call" + subtype + oneOf tool fields)
 * - thinking uses top-level type:"thinking" with delta/completed subtypes
 * 
 * This module converts the Cursor-specific formats into Claude-compatible SDKMessages
 * so they can flow through the existing sdkToLogConverter → sessionProtocolMapper pipeline.
 */

import type { SDKMessage } from '@/claude/sdk'

interface CursorNormalizerState {
  thinkingBuffer: string;
}

interface CursorNormalizer {
  normalize: (msg: Record<string, unknown>) => SDKMessage[];
  flush: () => SDKMessage[];
}

function extractToolInfo(toolCall: Record<string, unknown>): { name: string; title: string; args: Record<string, unknown> } {
  if ('editToolCall' in toolCall) {
    const edit = toolCall.editToolCall as { args: { path: string; streamContent?: string } };
    return {
      name: 'Write',
      title: `Write to ${edit.args.path}`,
      args: edit.args,
    };
  }
  if ('shellToolCall' in toolCall) {
    const shell = toolCall.shellToolCall as { args: { command: string }; description?: string };
    return {
      name: 'Shell',
      title: shell.description || `Run: ${shell.args.command}`,
      args: shell.args,
    };
  }
  const key = Object.keys(toolCall)[0];
  const inner = (toolCall[key] as Record<string, unknown> | undefined);
  return {
    name: key ?? 'unknown',
    title: key ?? 'unknown',
    args: (inner?.args as Record<string, unknown>) ?? {},
  };
}

function formatToolResult(toolCall: Record<string, unknown>): string {
  const key = Object.keys(toolCall)[0];
  if (!key) return 'No result';
  const inner = (toolCall[key] as Record<string, unknown> | undefined)?.result as Record<string, unknown> | undefined;
  if (!inner) return 'No result';
  const success = inner.success as Record<string, unknown> | undefined;
  if (success) {
    if (typeof success.stdout === 'string') return success.stdout;
    if (typeof success.message === 'string') return success.message;
    return JSON.stringify(success);
  }
  if (inner.error) return `Error: ${JSON.stringify(inner.error)}`;
  return JSON.stringify(inner);
}

const CURSOR_MODEL = 'cursor-agent';

function emitThinking(buffer: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: CURSOR_MODEL,
      content: [{ type: 'thinking', thinking: buffer }],
    },
  };
}

export function createCursorNormalizer(): CursorNormalizer {
  const state: CursorNormalizerState = {
    thinkingBuffer: '',
  };

  function normalize(msg: Record<string, unknown>): SDKMessage[] {
    switch (msg.type) {
      case 'thinking': {
        if (msg.subtype === 'delta') {
          state.thinkingBuffer += msg.text as string;
          return [];
        }
        if (msg.subtype === 'completed') {
          if (!state.thinkingBuffer) return [];
          const result = emitThinking(state.thinkingBuffer);
          state.thinkingBuffer = '';
          return [result];
        }
        return [];
      }

      case 'tool_call': {
        const toolCallData = msg.tool_call as Record<string, unknown>;
        if (msg.subtype === 'started') {
          const { name, title, args } = extractToolInfo(toolCallData);
          return [{
            type: 'assistant',
            message: {
              role: 'assistant',
              model: CURSOR_MODEL,
              content: [{
                type: 'tool_use',
                id: msg.call_id as string,
                name,
                input: { ...args, description: title },
              }],
            },
          }];
        }
        if (msg.subtype === 'completed') {
          return [{
            type: 'user',
            message: {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: msg.call_id as string,
                content: formatToolResult(toolCallData),
              }],
            },
          }];
        }
        return [];
      }

      case 'result':
        return [];

      default: {
        const sdkMsg = msg as SDKMessage;
        if (sdkMsg.type === 'assistant') {
          const message = sdkMsg.message as Record<string, unknown> | undefined;
          if (message && !message.model) {
            message.model = CURSOR_MODEL;
          }
        }
        return [sdkMsg];
      }
    }
  }

  function flush(): SDKMessage[] {
    if (!state.thinkingBuffer) return [];
    const result = emitThinking(state.thinkingBuffer);
    state.thinkingBuffer = '';
    return [result];
  }

  return { normalize, flush };
}

export { extractToolInfo, formatToolResult };
export type { CursorNormalizer };
