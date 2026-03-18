import { describe, it, expect } from 'vitest';
import { createCursorNormalizer, extractToolInfo, formatToolResult } from './normalizeCursorMessage';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('createCursorNormalizer', () => {
  describe('pass-through messages', () => {
    it('passes system messages through unchanged', () => {
      const normalizer = createCursorNormalizer();
      const msg = {
        type: 'system',
        subtype: 'init',
        apiKeySource: 'login',
        cwd: '/tmp/test',
        session_id: 'test-session',
        model: 'Claude 4.6 Opus (Thinking)',
        permissionMode: 'default',
      };
      const result = normalizer.normalize(msg);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(msg);
    });

    it('passes user messages through unchanged', () => {
      const normalizer = createCursorNormalizer();
      const msg = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
        session_id: 'test-session',
      };
      const result = normalizer.normalize(msg);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(msg);
    });

    it('passes assistant messages through unchanged', () => {
      const normalizer = createCursorNormalizer();
      const msg = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello back' }],
        },
        session_id: 'test-session',
      };
      const result = normalizer.normalize(msg);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(msg);
    });
  });

  describe('thinking buffering', () => {
    it('accumulates thinking deltas and returns empty array', () => {
      const normalizer = createCursorNormalizer();
      const result = normalizer.normalize({
        type: 'thinking',
        subtype: 'delta',
        text: 'Hello',
        session_id: 'test',
        timestamp_ms: 123,
      });
      expect(result).toHaveLength(0);
    });

    it('emits accumulated thinking on completed', () => {
      const normalizer = createCursorNormalizer();
      normalizer.normalize({ type: 'thinking', subtype: 'delta', text: 'The ' });
      normalizer.normalize({ type: 'thinking', subtype: 'delta', text: 'user wants' });
      normalizer.normalize({ type: 'thinking', subtype: 'delta', text: ' help.' });

      const result = normalizer.normalize({ type: 'thinking', subtype: 'completed' });
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'The user wants help.' }],
        },
      });
    });

    it('returns empty array for completed with empty buffer', () => {
      const normalizer = createCursorNormalizer();
      const result = normalizer.normalize({ type: 'thinking', subtype: 'completed' });
      expect(result).toHaveLength(0);
    });
  });

  describe('tool_call normalization', () => {
    it('converts editToolCall started to assistant tool_use', () => {
      const normalizer = createCursorNormalizer();
      const result = normalizer.normalize({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'toolu_01EJ7',
        tool_call: {
          editToolCall: {
            args: { path: '/tmp/hello.txt', streamContent: 'Hello World\n' },
          },
        },
        session_id: 'test',
        timestamp_ms: 123,
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('assistant');
      const content = (result[0] as any).message.content;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('tool_use');
      expect(content[0].id).toBe('toolu_01EJ7');
      expect(content[0].name).toBe('Write');
      expect(content[0].input.path).toBe('/tmp/hello.txt');
      expect(content[0].input.description).toBe('Write to /tmp/hello.txt');
    });

    it('converts shellToolCall started to assistant tool_use', () => {
      const normalizer = createCursorNormalizer();
      const result = normalizer.normalize({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'toolu_01WCy',
        tool_call: {
          shellToolCall: {
            args: { command: 'ls' },
            description: 'List files in current directory',
          },
        },
        session_id: 'test',
        timestamp_ms: 123,
      });

      expect(result).toHaveLength(1);
      const content = (result[0] as any).message.content;
      expect(content[0].name).toBe('Shell');
      expect(content[0].input.description).toBe('List files in current directory');
    });

    it('converts tool_call completed to user tool_result', () => {
      const normalizer = createCursorNormalizer();
      const result = normalizer.normalize({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'toolu_01WCy',
        tool_call: {
          shellToolCall: {
            args: { command: 'ls' },
            result: {
              success: {
                exitCode: 0,
                stdout: 'hello.txt\n',
                stderr: '',
              },
            },
          },
        },
        session_id: 'test',
        timestamp_ms: 123,
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('user');
      const content = (result[0] as any).message.content;
      expect(content[0].type).toBe('tool_result');
      expect(content[0].tool_use_id).toBe('toolu_01WCy');
      expect(content[0].content).toBe('hello.txt\n');
    });
  });

  describe('result drop', () => {
    it('drops result messages', () => {
      const normalizer = createCursorNormalizer();
      const result = normalizer.normalize({
        type: 'result',
        subtype: 'success',
        duration_ms: 12239,
        is_error: false,
        result: 'done',
        session_id: 'test',
      });
      expect(result).toHaveLength(0);
    });
  });

  describe('flush', () => {
    it('flushes accumulated thinking', () => {
      const normalizer = createCursorNormalizer();
      normalizer.normalize({ type: 'thinking', subtype: 'delta', text: 'thinking ' });
      normalizer.normalize({ type: 'thinking', subtype: 'delta', text: 'about ' });
      normalizer.normalize({ type: 'thinking', subtype: 'delta', text: 'stuff' });

      const result = normalizer.flush();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'thinking about stuff' }],
        },
      });
    });

    it('returns empty array when nothing buffered', () => {
      const normalizer = createCursorNormalizer();
      expect(normalizer.flush()).toHaveLength(0);
    });
  });

  describe('full sequence from fixture', () => {
    it('processes a full Cursor session correctly', () => {
      const fixture = readFileSync(
        join(__dirname, '__fixtures__', 'cursor-stream-test.jsonl'),
        'utf-8',
      );
      const lines = fixture.trim().split('\n').map(line => JSON.parse(line));
      const normalizer = createCursorNormalizer();
      const allMessages: any[] = [];

      for (const line of lines) {
        const normalized = normalizer.normalize(line);
        allMessages.push(...normalized);
      }
      const flushed = normalizer.flush();
      allMessages.push(...flushed);

      // system pass-through
      expect(allMessages[0].type).toBe('system');
      expect(allMessages[0].subtype).toBe('init');

      // user pass-through
      expect(allMessages[1].type).toBe('user');

      // thinking → assistant with thinking content
      expect(allMessages[2].type).toBe('assistant');
      expect(allMessages[2].message.content[0].type).toBe('thinking');
      expect(allMessages[2].message.content[0].thinking).toContain('The user wants');

      // editToolCall started → assistant with tool_use
      expect(allMessages[3].type).toBe('assistant');
      expect(allMessages[3].message.content[0].type).toBe('tool_use');
      expect(allMessages[3].message.content[0].name).toBe('Write');

      // editToolCall completed → user with tool_result
      expect(allMessages[4].type).toBe('user');
      expect(allMessages[4].message.content[0].type).toBe('tool_result');

      // shellToolCall started → assistant with tool_use
      expect(allMessages[5].type).toBe('assistant');
      expect(allMessages[5].message.content[0].name).toBe('Shell');

      // shellToolCall completed → user with tool_result
      expect(allMessages[6].type).toBe('user');
      expect(allMessages[6].message.content[0].content).toContain('hello.txt');

      // assistant pass-through
      expect(allMessages[7].type).toBe('assistant');
      expect(allMessages[7].message.content[0].type).toBe('text');

      // result is dropped, so total = 8
      expect(allMessages).toHaveLength(8);
    });
  });
});

describe('extractToolInfo', () => {
  it('extracts editToolCall info', () => {
    const info = extractToolInfo({ editToolCall: { args: { path: '/tmp/foo.ts' } } });
    expect(info.name).toBe('Write');
    expect(info.title).toBe('Write to /tmp/foo.ts');
    expect(info.args.path).toBe('/tmp/foo.ts');
  });

  it('extracts shellToolCall info with description', () => {
    const info = extractToolInfo({
      shellToolCall: { args: { command: 'ls -la' }, description: 'List all files' },
    });
    expect(info.name).toBe('Shell');
    expect(info.title).toBe('List all files');
  });

  it('extracts shellToolCall info without description', () => {
    const info = extractToolInfo({
      shellToolCall: { args: { command: 'pwd' } },
    });
    expect(info.title).toBe('Run: pwd');
  });

  it('handles unknown tool types', () => {
    const info = extractToolInfo({
      readToolCall: { args: { path: '/tmp/file.ts' } },
    });
    expect(info.name).toBe('readToolCall');
    expect(info.title).toBe('readToolCall');
  });
});

describe('formatToolResult', () => {
  it('extracts stdout from shell success', () => {
    const result = formatToolResult({
      shellToolCall: {
        args: {},
        result: { success: { exitCode: 0, stdout: 'output\n' } },
      },
    });
    expect(result).toBe('output\n');
  });

  it('extracts message from edit success', () => {
    const result = formatToolResult({
      editToolCall: {
        args: {},
        result: { success: { message: 'Wrote file', path: '/tmp/foo.txt' } },
      },
    });
    expect(result).toBe('Wrote file');
  });

  it('formats error results', () => {
    const result = formatToolResult({
      shellToolCall: {
        args: {},
        result: { error: { message: 'command not found' } },
      },
    });
    expect(result).toContain('Error:');
    expect(result).toContain('command not found');
  });

  it('returns "No result" when no result field', () => {
    const result = formatToolResult({
      shellToolCall: { args: {} },
    });
    expect(result).toBe('No result');
  });
});
