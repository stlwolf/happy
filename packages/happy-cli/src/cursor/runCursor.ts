/**
 * Cursor Agent Runner
 * 
 * Launches Cursor Agent CLI, normalizes its stream-json output into Claude-compatible
 * SDKMessages, and pipes them through the existing sdkToLogConverter → sessionProtocolMapper
 * pipeline for remote monitoring via Happy Coder infrastructure.
 */

import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';
import { type Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { SDKToLogConverter } from '@/claude/utils/sdkToLogConverter';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { connectionState } from '@/utils/serverConnectionErrors';
import { createCursorNormalizer, type CursorNormalizer } from './normalizeCursorMessage';
import { spawnCursorAgent, type CursorProcessOptions } from './cursorProcess';
import type { ChildProcess } from 'node:child_process';

export interface RunCursorOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  noSandbox?: boolean;
}

export async function runCursor(opts: RunCursorOptions): Promise<void> {
  const sessionTag = randomUUID();
  connectionState.setBackend('cursor');

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: 'claude',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    sandbox: opts.noSandbox ? undefined : settings.sandboxConfig,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  if (response) {
    logger.debug(`[cursor] Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    },
  });
  session = initialSession;

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata);
    } catch (e) {
      logger.debug('[cursor] Failed to notify daemon:', e);
    }
  }

  let thinking = false;
  let shouldExit = false;
  let abortController = new AbortController();
  let activeChild: ChildProcess | null = null;
  let cursorSessionId: string | undefined;

  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  session.rpcHandlerManager.registerHandler('abort', async () => {
    if (activeChild && !activeChild.killed) {
      activeChild.kill('SIGTERM');
    }
    abortController.abort();
    return { success: true };
  });

  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    if (activeChild && !activeChild.killed) {
      activeChild.kill('SIGTERM');
    }
    abortController.abort();
  });

  const messageQueue = new MessageQueue2<Record<string, never>>((mode) => hashObject(mode));

  session.onUserMessage((message) => {
    if (!message.content.text) return;
    messageQueue.push(message.content.text, {});
  });

  const sdkToLogConverter = new SDKToLogConverter(
    { sessionId: sessionTag, cwd: process.cwd() },
    new Map(),
  );

  const sendLogMessage = (logMessage: ReturnType<SDKToLogConverter['convert']>) => {
    if (!logMessage) return;
    session.sendLegacyLogMessage(logMessage);
  };

  const processMessages = async (
    messages: AsyncIterable<Record<string, unknown>>,
    normalizer: CursorNormalizer,
    ongoingToolCalls: Map<string, string | null>,
  ): Promise<void> => {
    for await (const rawMsg of messages) {
      logger.debug(`[cursor] Raw message: type=${rawMsg.type} subtype=${rawMsg.subtype ?? ''}`);
      if (rawMsg.type === 'thinking') {
        const nextThinking = rawMsg.subtype === 'delta';
        if (thinking !== nextThinking) {
          thinking = nextThinking;
          session.keepAlive(thinking, 'remote');
        }
      }

      if (rawMsg.type === 'tool_call' && rawMsg.subtype === 'started') {
        ongoingToolCalls.set(rawMsg.call_id as string, null);
      }
      if (rawMsg.type === 'tool_call' && rawMsg.subtype === 'completed') {
        ongoingToolCalls.delete(rawMsg.call_id as string);
      }

      if (rawMsg.type === 'result' && rawMsg.is_error === true) {
        logger.debug(`[cursor] Agent reported error: ${rawMsg.result}`);
      }

      const sdkMessages = normalizer.normalize(rawMsg);
      for (const sdkMsg of sdkMessages) {
        try {
          const logMessage = sdkToLogConverter.convert(sdkMsg);
          logger.debug(`[cursor] Sending legacy log message for type=${sdkMsg.type}`);
          sendLogMessage(logMessage);
        } catch (e) {
          logger.debug('[cursor] Failed to process message:', e);
        }
      }
    }

    const remaining = normalizer.flush();
    for (const sdkMsg of remaining) {
      try {
        sendLogMessage(sdkToLogConverter.convert(sdkMsg));
      } catch (e) {
        logger.debug('[cursor] Failed to process flushed message:', e);
      }
    }
  };

  const interruptOngoingToolCalls = (ongoingToolCalls: Map<string, string | null>) => {
    for (const [callId, parentToolCallId] of ongoingToolCalls) {
      const interrupted = sdkToLogConverter.generateInterruptedToolResult(callId, parentToolCallId);
      sendLogMessage(interrupted);
    }
    ongoingToolCalls.clear();
  };

  console.log('Waiting for prompt from mobile app...');

  try {
    while (!shouldExit) {
      const batch = await messageQueue.waitForMessagesAndGetAsString(abortController.signal);
      if (!batch) break;

      const normalizer = createCursorNormalizer();
      const ongoingToolCalls = new Map<string, string | null>();

      const spawnOpts: CursorProcessOptions = {
        prompt: batch.message,
        cwd: process.cwd(),
        ...(cursorSessionId ? { resume: cursorSessionId } : {}),
      };

      const { messages, child, sessionId } = spawnCursorAgent(spawnOpts);
      activeChild = child;

      child.stderr?.on('data', (data: Buffer) => {
        logger.debug(`[cursor] stderr: ${data.toString()}`);
      });

      sessionId.then((resolvedId) => {
        if (!cursorSessionId) {
          cursorSessionId = resolvedId;
          sdkToLogConverter.updateSessionId(resolvedId);
          logger.debug(`[cursor] Cursor session ID: ${resolvedId}`);
        }
      }).catch((e) => {
        logger.debug('[cursor] Failed to get session ID:', e);
      });

      try {
        await processMessages(messages, normalizer, ongoingToolCalls);
      } finally {
        interruptOngoingToolCalls(ongoingToolCalls);
        activeChild = null;
      }

      abortController = new AbortController();
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    if (activeChild && !activeChild.killed) {
      activeChild.kill('SIGTERM');
    }

    session.updateMetadata((currentMetadata) => ({
      ...currentMetadata,
      lifecycleState: 'archived',
      lifecycleStateSince: Date.now(),
    }));
    session.sendSessionDeath();
    await session.flush();
    await session.close();
  }
}
