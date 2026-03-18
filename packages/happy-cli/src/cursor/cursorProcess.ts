/**
 * Cursor Agent CLI process management.
 * Handles binary detection, process spawning, and stdout JSONL parsing.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface CursorProcessOptions {
  prompt: string;
  cwd: string;
  model?: string;
  resume?: string;
  approveMcps?: boolean;
}

export interface CursorProcessResult {
  messages: AsyncIterable<Record<string, unknown>>;
  child: ChildProcess;
  sessionId: Promise<string>;
}

export function getCursorAgentPath(): string {
  if (process.env.HAPPY_CURSOR_PATH) {
    return process.env.HAPPY_CURSOR_PATH;
  }

  const home = homedir();
  const agentDirect = join(home, '.local', 'bin', 'agent');
  if (existsSync(agentDirect)) {
    return agentDirect;
  }

  const versionsDir = join(home, '.local', 'share', 'cursor-agent', 'versions');
  if (existsSync(versionsDir)) {
    try {
      const versions = readdirSync(versionsDir).sort().reverse();
      for (const version of versions) {
        const candidate = join(versionsDir, version, 'cursor-agent');
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
      // fall through to which
    }
  }

  try {
    const whichResult = execSync('which cursor', { encoding: 'utf-8' }).trim();
    if (whichResult) return whichResult;
  } catch {
    // not found
  }

  throw new Error(
    'Cursor Agent CLI not found. Install cursor-agent or set HAPPY_CURSOR_PATH environment variable.',
  );
}

export function buildSpawnArgs(opts: CursorProcessOptions): string[] {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--force',
    '--trust',
    '--workspace', opts.cwd,
  ];

  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.approveMcps) {
    args.push('--approve-mcps');
  }
  if (opts.resume) {
    args.push('--resume', opts.resume);
  }

  args.push(opts.prompt);
  return args;
}

export function spawnCursorAgent(opts: CursorProcessOptions): CursorProcessResult {
  const agentPath = getCursorAgentPath();
  const args = buildSpawnArgs(opts);

  logger.debug(`[cursor] Spawning: ${agentPath} ${args.join(' ')}`);

  const child = spawn(agentPath, args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FORCE_COLOR: '0',
    },
  });

  let sessionIdResolve: (id: string) => void;
  let sessionIdReject: (err: Error) => void;
  const sessionId = new Promise<string>((resolve, reject) => {
    sessionIdResolve = resolve;
    sessionIdReject = reject;
  });

  let sessionIdResolved = false;

  child.on('error', (err) => {
    if (!sessionIdResolved) {
      sessionIdResolved = true;
      sessionIdReject(err);
    }
  });

  async function* parseMessages(): AsyncGenerator<Record<string, unknown>> {
    if (!child.stdout) {
      if (!sessionIdResolved) {
        sessionIdResolved = true;
        sessionIdReject(new Error('Cursor process has no stdout'));
      }
      return;
    }

    const rl = createInterface({ input: child.stdout });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;

        if (!sessionIdResolved && msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
          sessionIdResolved = true;
          sessionIdResolve(msg.session_id);
        }

        yield msg;
      } catch (e) {
        logger.debug(`[cursor] Failed to parse JSON line: ${line}`, e);
      }
    }

    if (!sessionIdResolved) {
      sessionIdResolved = true;
      sessionIdReject(new Error('Cursor process exited without producing a session_id'));
    }
  }

  return {
    messages: parseMessages(),
    child,
    sessionId,
  };
}
