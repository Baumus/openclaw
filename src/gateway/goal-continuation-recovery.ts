import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner/types.js";
import { discoverRestartRecoveryStoreTargets } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { resolvePersistedOverrideModelRef } from "../agents/model-selection-persisted.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { createFollowupRunner } from "../auto-reply/reply/followup-runner.js";
import {
  attachGoalContinuationPendingInputLifecycle,
  readPendingGoalContinuation,
  stageGoalContinuationPendingInput,
  type PendingGoalContinuation,
} from "../auto-reply/reply/goal-continuation-pending.js";
import { withGoalContinuationCommand } from "../auto-reply/reply/goal-continuation-return.js";
import {
  createGoalContinuationReturn,
  GOAL_CONTINUATION_PROMPT,
  isGoalContinuationCurrent,
  isGoalContinuationOutcome,
} from "../auto-reply/reply/goal-continuation.js";
import type { GoalContinuation } from "../auto-reply/reply/goal-continuation.types.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "../auto-reply/reply/queue/enqueue.js";
import { resolveQueueSettings } from "../auto-reply/reply/queue/settings-runtime.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import { createTypingController } from "../auto-reply/reply/typing.js";
import { resolveSessionFilePathCore } from "../config/sessions/paths.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { readPendingInputRecoveryEntriesInWorker } from "../config/sessions/session-entry-read-maintenance.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { readGoalContinuationRecoveryPage } from "../config/sessions/session-pending-input-history.js";
import { readPendingInputSource } from "../config/sessions/session-pending-input-source.js";
import { discardSessionPendingInput } from "../config/sessions/session-pending-input-withdrawal.js";
import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { sleepWithAbort } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isTransientRestartRecoveryError } from "../infra/restart-recovery-errors.js";
import { retryAsync } from "../infra/retry.js";
import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareRecoverySource } from "./session-recovery-source.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

/** Startup replays admitted pending inputs, never discovers work from active Goals. */
export async function recoverGoalContinuations(
  context: GatewayRequestContext,
  signal: AbortSignal,
) {
  const cfg = context.getRuntimeConfig();
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (context.getRuntimeConfig() !== cfg) {
      throw new Error("Goal recovery configuration changed");
    }
  };
  const retry = <T>(run: () => Promise<T>) =>
    retryAsync(run, {
      attempts: 3,
      minDelayMs: 5_000,
      maxDelayMs: 10_000,
      shouldRetry: (error) => !signal.aborted && isTransientRestartRecoveryError(error),
      sleep: (ms) => sleepWithAbort(ms, signal, { ref: false }),
    });
  for (const target of await retry(() =>
    discoverRestartRecoveryStoreTargets({ cfg, shouldContinue: () => !signal.aborted }),
  )) {
    assertCurrent();
    for (const { sessionKey, entry } of await retry(() =>
      readPendingInputRecoveryEntriesInWorker(target),
    )) {
      const scope = {
        ...target,
        agentId: parseAgentSessionKey(sessionKey)?.agentId ?? target.agentId,
        sessionKey,
        sessionId: entry.sessionId,
      };
      const pending: SessionPendingInput[] = [];
      let before: number | undefined;
      do {
        const page = await retry(() => readGoalContinuationRecoveryPage(scope, { before }));
        pending.unshift(...page.items);
        before = page.nextBefore;
      } while (before !== undefined);
      for (const input of pending) {
        const goal = readPendingGoalContinuation(input.message);
        if (!goal || input.state !== "interrupted") {
          continue;
        }
        if (
          goal.agentId !== scope.agentId ||
          goal.sessionKey !== sessionKey ||
          goal.continuation.sessionId !== scope.sessionId ||
          goal.runId !== input.runId
        ) {
          await discardSessionPendingInput(scope, input.runId, assertCurrent);
          continue;
        }
        let attempts = 0;
        try {
          await retry(async () => {
            attempts++;
            assertCurrent();
            const retained = await readPendingInputSource(
              scope,
              input.message.idempotencyKey!,
              true,
            );
            const row = retained?.snapshot.pending;
            if (
              !retained?.snapshot.current ||
              !row ||
              row.input_id !== input.id ||
              row.state !== "interrupted" ||
              row.consumed_event_id != null ||
              row.message_json !== JSON.stringify(input.message)
            ) {
              return;
            }
            const selected = await resolveGatewaySessionStoreTargetInWorker({
              cfg,
              key: sessionKey,
              agentId: scope.agentId,
              assertActive: assertCurrent,
            });
            using source = await prepareRecoverySource({
              cfg,
              target: selected,
              commitGuard: assertCurrent,
            });
            await source.refresh();
            if (!isGoalContinuationCurrent(goal.continuation, source.current())) {
              await discardSessionPendingInput(scope, input.runId, assertCurrent);
              return;
            }
            let accepted = false;
            const guard = () => {
              assertCurrent();
              if (!accepted) {
                retained.assertCurrent();
                if (!isGoalContinuationCurrent(goal.continuation, source.current())) {
                  throw new Error("Goal changed before pending continuation admission");
                }
              }
            };
            const operator = await restoreGatewayQueuedOperatorRecovery({
              source: goal.operatorSource,
              context,
              assertCurrent: guard,
            });
            try {
              accepted = await enqueueRecoveredGoalContinuation({
                context,
                entry: source.current()!,
                sessionKey,
                storePath: scope.storePath,
                goal,
                message: input.message,
                operatorAuthority: operator.authority,
                signal,
                assertCurrent: guard,
              });
            } finally {
              operator.release();
            }
          });
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          context.logGateway.warn(
            `Pending Goal continuation recovery failed: ${formatErrorMessage(error)}`,
          );
          const customType = "goal-continuation-recovery-blocked";
          const content =
            `The saved Goal continuation could not restart automatically after ${attempts} attempt(s). ` +
            "The Goal and transcript are preserved. Check current access and service availability, then use /goal resume to continue.";
          const reported = await withSessionTranscriptWriteAssertion(scope, assertCurrent, () =>
            appendSessionTranscriptReport(scope, {
              kind: "custom",
              customTypes: [customType],
              selectReport: (latest) =>
                latest?.content === content &&
                JSON.stringify(latest.details) === JSON.stringify({ inputId: input.id, attempts })
                  ? undefined
                  : {
                      customType,
                      content,
                      details: { inputId: input.id, attempts },
                      display: true,
                      excludeFromContext: true,
                    },
            }),
          );
          if (!reported.ok) {
            context.logGateway.warn(
              "Could not record pending Goal recovery notice; input retained.",
            );
          }
        }
      }
    }
  }
}

export function buildRecoveredGoalFollowup(params: {
  context: GatewayRequestContext;
  entry: SessionEntry;
  sessionKey: string;
  goal: PendingGoalContinuation;
  operatorAuthority: AdmittedRunOperatorAuthority;
  signal?: AbortSignal;
  enqueuedAt?: number;
}): FollowupRun {
  const { context, entry: current, sessionKey, goal, operatorAuthority, signal } = params;
  const cfg = context.getRuntimeConfig();
  const defaultModel = resolveDefaultModelForAgent({ cfg, agentId: goal.agentId });
  const model =
    resolvePersistedOverrideModelRef({
      defaultProvider: defaultModel.provider,
      overrideProvider: current.providerOverride,
      overrideModel: current.modelOverride,
    }) ?? defaultModel;
  return {
    prompt: goal.prompt,
    enqueuedAt: params.enqueuedAt ?? Date.now(),
    messageId: goal.runId,
    goalContinuation: goal.continuation,
    disableCollectBatching: true,
    operatorAuthority,
    abortSignal: signal,
    readAdmissionConfig: context.getRuntimeConfig,
    originatingChannel: goal.delivery?.channel,
    originatingTo: goal.delivery?.to,
    originatingAccountId: goal.delivery?.accountId,
    originatingThreadId: goal.delivery?.threadId,
    run: {
      agentId: goal.agentId,
      sessionKey,
      sessionId: current.sessionId,
      agentDir: resolveAgentDir(cfg, goal.agentId),
      workspaceDir: resolveAgentWorkspaceDir(cfg, goal.agentId),
      sessionFile: resolveSessionFilePathCore(current.sessionId, current, {
        agentId: goal.agentId,
      }),
      config: cfg,
      provider: model.provider,
      model: model.model,
      hasSessionModelOverride: Boolean(current.modelOverride),
      authProfileId: current.authProfileOverride,
      permissionMode: current.permissionMode,
      timeoutMs: resolveAgentTimeoutMs({ cfg }),
      blockReplyBreak: "text_end",
      inputProvenance: { kind: "internal_system", sourceTool: "session_goal_continue" },
      messageProvider: goal.delivery?.channel ?? INTERNAL_MESSAGE_CHANNEL,
      suppressNextUserMessagePersistence: true,
    },
  };
}

/** A recovered command has an ordinary controller operation; reuse its Goal return owner. */
export function createRecoveredGoalCommandReturn(params: {
  context: GatewayRequestContext;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
  runId: string;
  agentId: string;
  operation: ReplyOperation;
  operatorAuthority: AdmittedRunOperatorAuthority;
  delivery?: PendingGoalContinuation["delivery"];
  signal?: AbortSignal;
}): <T>(run: () => T) => T {
  const continuation = params.entry.restartRecoveryGoalContinuation;
  if (!continuation || !isGoalContinuationCurrent(continuation, params.entry)) {
    return (run) => run();
  }
  params.operatorAuthority.assertCurrent();
  const cfg = params.context.getRuntimeConfig();
  const base = buildRecoveredGoalFollowup({
    ...params,
    goal: {
      version: 1,
      runId: params.runId,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      continuation,
      prompt: GOAL_CONTINUATION_PROMPT,
      operatorSource: undefined,
      delivery: params.delivery,
    },
  });
  const runFollowup = createFollowupRunner({
    resolveGatewayContext: () => params.context,
    typing: createTypingController({}),
    typingMode: "never",
    sessionEntry: params.entry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    defaultModel: base.run.model,
  });
  const scope = createGoalContinuationReturn({
    base,
    initialGoalId: continuation.goalId,
    expectedSession: params.entry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    queueKey: params.sessionKey,
    operation: params.operation,
    settings: resolveQueueSettings({
      cfg,
      sessionEntry: params.entry,
      channel: params.delivery?.channel,
    }),
    runFollowup,
  });
  return (run) =>
    scope(() =>
      withGoalContinuationCommand(
        {
          runId: params.runId,
          sessionKey: params.sessionKey,
          entry: params.entry,
        },
        run,
      ),
    );
}

/** Restore Goal work through the same queue owner that chains ordinary follow-up turns. */
export async function enqueueRecoveredGoalContinuation(params: {
  context: GatewayRequestContext;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
  goal: PendingGoalContinuation;
  message?: PersistedUserTurnMessage;
  sourceResult?: EmbeddedAgentRunResult;
  operatorAuthority: AdmittedRunOperatorAuthority;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<boolean> {
  params.assertCurrent();
  const { goal, context, signal } = params;
  const { sessionKey, storePath } = params;
  const cfg = context.getRuntimeConfig();
  const current = await readSessionEntryReadOnlyInWorker({ storePath, sessionKey });
  params.assertCurrent();
  if (
    !current ||
    current.sessionId !== params.entry.sessionId ||
    !isGoalContinuationCurrent(goal.continuation, current) ||
    getFollowupQueueDepth(sessionKey) > 0
  ) {
    return false;
  }
  if (!params.message) {
    if (!params.sourceResult || !isGoalContinuationOutcome(params.sourceResult)) {
      return false;
    }
    const { listUnsettledRequesterChildren } =
      await import("../agents/subagents/registry/subagent-registry.js");
    const children = await listUnsettledRequesterChildren({
      requesterSessionKey: sessionKey,
      requesterAgentId: goal.agentId,
    });
    params.assertCurrent();
    if (children.length > 0 || getFollowupQueueDepth(sessionKey) > 0) {
      return false;
    }
  }
  const defaultModel = resolveDefaultModelForAgent({ cfg, agentId: goal.agentId });
  const recorder = params.message
    ? createUserTurnTranscriptRecorder({
        message: params.message,
        trackInputCompletion: true,
        target: {
          agentId: goal.agentId,
          sessionId: current.sessionId,
          sessionKey,
          storePath,
          sessionEntry: current,
          expectedSessionId: current.sessionId,
        },
      })
    : undefined;
  if (
    recorder &&
    !(await recorder.stageApproved!({ runId: goal.runId, assertCurrent: params.assertCurrent }))
  ) {
    return false;
  }
  const queued = buildRecoveredGoalFollowup({
    context,
    entry: current,
    sessionKey,
    goal,
    operatorAuthority: params.operatorAuthority,
    signal,
    enqueuedAt: params.message?.timestamp,
  });
  queued.userTurnTranscriptRecorder = recorder;
  if (recorder) {
    attachGoalContinuationPendingInputLifecycle(queued);
  }
  const runner = createFollowupRunner({
    resolveGatewayContext: () => context,
    typing: createTypingController({}),
    typingMode: "never",
    sessionEntry: current,
    sessionKey,
    storePath,
    defaultModel: defaultModel.model,
  });
  const settings = resolveQueueSettings({
    cfg,
    sessionEntry: current,
    channel: goal.delivery?.channel,
  });
  // Queue ownership retains authenticated authority before this temporary restore closes.
  if (!recorder) {
    await stageGoalContinuationPendingInput({
      nudge: queued,
      entry: current,
      sessionKey,
      storePath,
      assertCurrent: params.assertCurrent,
    });
  }
  params.assertCurrent();
  const accepted = enqueueFollowupRun(sessionKey, queued, settings, "message-id", runner, true, {
    storePath,
  });
  // A duplicate queue admission may already own this exact accepted input. Do not
  // cancel its durable row merely because another enqueue won.
  return accepted;
}

/** A settled recovered command returns its next turn to the same Goal queue. */
export async function resumeCompletedGoalContinuation(params: {
  continuation: GoalContinuation;
  entry?: SessionEntry;
  source: { sessionKey?: string; storePath?: string; runId: string; sessionAgentId: string };
  options: Pick<AgentCommandOpts, "operatorAuthority" | "abortSignal">;
  result: EmbeddedAgentRunResult;
  succeeded: boolean;
  deliveryContext?: DeliveryContext;
  lifecycleGeneration: string;
}): Promise<void> {
  const { continuation, entry, source, deliveryContext } = params;
  const { operatorAuthority, abortSignal: signal } = params.options;
  if (
    !params.succeeded ||
    !entry ||
    !source.sessionKey ||
    !source.storePath ||
    !operatorAuthority
  ) {
    return;
  }
  const context = getInProcessGatewayRequestContext();
  if (!context) {
    return;
  }
  await enqueueRecoveredGoalContinuation({
    context,
    entry,
    sessionKey: source.sessionKey,
    storePath: source.storePath,
    operatorAuthority,
    sourceResult: params.result,
    signal,
    assertCurrent: () => {
      signal?.throwIfAborted();
      operatorAuthority.assertCurrent();
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
    },
    goal: {
      version: 1,
      runId: ["goal", continuation.sessionId, continuation.goalId, source.runId].join(":"),
      agentId: source.sessionAgentId,
      sessionKey: source.sessionKey,
      continuation,
      prompt: GOAL_CONTINUATION_PROMPT,
      operatorSource: undefined,
      ...(deliveryContext?.channel && deliveryContext.to
        ? {
            delivery: {
              ...deliveryContext,
              channel: deliveryContext.channel,
              to: deliveryContext.to,
            },
          }
        : {}),
    },
  });
}
