import { describe, it, expect } from 'vitest';
import { buildSpawnArgs } from './cursorProcess';

describe('buildSpawnArgs', () => {
  it('builds basic args with required fields', () => {
    const args = buildSpawnArgs({
      prompt: 'say hello',
      cwd: '/tmp/workspace',
    });

    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--force');
    expect(args).toContain('--trust');
    expect(args).toContain('--workspace');
    expect(args).toContain('/tmp/workspace');
    expect(args[args.length - 1]).toBe('say hello');
  });

  it('includes --model when specified', () => {
    const args = buildSpawnArgs({
      prompt: 'test',
      cwd: '/tmp',
      model: 'claude-4-opus',
    });

    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe('claude-4-opus');
  });

  it('includes --resume when specified', () => {
    const args = buildSpawnArgs({
      prompt: 'continue',
      cwd: '/tmp',
      resume: 'session-abc-123',
    });

    const resumeIdx = args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args[resumeIdx + 1]).toBe('session-abc-123');
  });

  it('includes --approve-mcps when specified', () => {
    const args = buildSpawnArgs({
      prompt: 'test',
      cwd: '/tmp',
      approveMcps: true,
    });

    expect(args).toContain('--approve-mcps');
  });

  it('does not include optional flags when not specified', () => {
    const args = buildSpawnArgs({
      prompt: 'test',
      cwd: '/tmp',
    });

    expect(args).not.toContain('--model');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--approve-mcps');
  });

  it('prompt is always the last argument', () => {
    const args = buildSpawnArgs({
      prompt: 'the prompt text',
      cwd: '/tmp',
      model: 'some-model',
      resume: 'some-session',
      approveMcps: true,
    });

    expect(args[args.length - 1]).toBe('the prompt text');
  });
});
