import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseSessionPendingInputMessage } from "../../config/sessions/session-pending-input-value.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { captureQueuedOperatorRecoverySource } from "../../gateway/operator-run-recovery-source.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import type { GoalContinuation } from "./goal-continuation.types.js";
import type { FollowupRun } from "./queue/types.js";

export type PendingGoalContinuation = {
  version: 1;
  runId: string;
  agentId: string;
  sessionKey: string;
  continuation: GoalContinuation;
  prompt: string;
  operatorSource: unknown;
  delivery?: { channel: string; to: string; accountId?: string; threadId?: string | number };
};

/** Queue withdrawal must release accepted input custody even when execution never starts. */
export function attachGoalContinuationPendingInputLifecycle(nudge: FollowupRun): void {
  const recorder = nudge.userTurnTranscriptRecorder;
  if (!recorder) {
    return;
  }
  let settled: Promise<void> | undefined;
  const settle = () => {
    settled ??= (async () => {
      if (!recorder.isPendingInputConsumed?.() && !recorder.getProcessingCompletion?.()) {
        recorder.finishPendingInput?.(
          getGatewayRestartDrainSignal().aborted ? "interrupted" : "cancelled",
        );
      }
      await recorder.waitForPendingInputSettlement?.();
    })();
    return settled;
  };
  nudge.turnAdoptionLifecycle = {
    onAdopted() {},
    onAbandoned: settle,
    // A stale Goal is consumed by queue admission without adopting the input.
    onSettled: settle,
  };
}

export function readPendingGoalContinuation(
  message: PersistedUserTurnMessage,
): PendingGoalContinuation | undefined {
  const value = message["__openclaw"]?.goalContinuation;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.runId !== "string" ||
    typeof value.agentId !== "string" ||
    typeof value.sessionKey !== "string" ||
    typeof value.prompt !== "string" ||
    !isRecord(value.continuation) ||
    typeof value.continuation.sessionId !== "string" ||
    typeof value.continuation.goalId !== "string" ||
    (value.continuation.lifecycleRevision !== undefined &&
      typeof value.continuation.lifecycleRevision !== "string") ||
    (value.continuation.workerGoal !== undefined && value.continuation.workerGoal !== true) ||
    message.idempotencyKey !== `${value.runId}:user` ||
    message.provenance?.kind !== "internal_system" ||
    message.provenance.sourceTool !== "session_goal_continue"
  ) {
    return undefined;
  }
  let delivery: PendingGoalContinuation["delivery"];
  if (value.delivery !== undefined) {
    const candidate = value.delivery;
    if (
      !isRecord(candidate) ||
      typeof candidate.channel !== "string" ||
      typeof candidate.to !== "string" ||
      (candidate.accountId !== undefined && typeof candidate.accountId !== "string") ||
      (candidate.threadId !== undefined &&
        typeof candidate.threadId !== "string" &&
        typeof candidate.threadId !== "number")
    ) {
      return undefined;
    }
    delivery = {
      channel: candidate.channel,
      to: candidate.to,
      accountId: candidate.accountId,
      threadId: candidate.threadId,
    };
  }
  return {
    version: 1,
    runId: value.runId,
    agentId: value.agentId,
    sessionKey: value.sessionKey,
    continuation: {
      sessionId: value.continuation.sessionId,
      goalId: value.continuation.goalId,
      lifecycleRevision: value.continuation.lifecycleRevision,
      ...(value.continuation.workerGoal === true ? { workerGoal: true } : {}),
    },
    prompt: value.prompt,
    operatorSource: value.operatorSource,
    ...(delivery ? { delivery } : {}),
  };
}

/** The existing pending-input owner retains an accepted nudge across process loss. */
export async function stageGoalContinuationPendingInput(params: {
  nudge: FollowupRun;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
  assertCurrent: () => void;
}): Promise<void> {
  const { nudge, entry } = params;
  const operatorSource = captureQueuedOperatorRecoverySource(nudge.operatorAuthority);
  if (
    !operatorSource ||
    operatorSource.kind === "unavailable" ||
    !nudge.run.agentId ||
    !nudge.goalContinuation ||
    !nudge.messageId
  ) {
    return;
  }
  const pending: PendingGoalContinuation = {
    version: 1,
    runId: nudge.messageId,
    agentId: nudge.run.agentId,
    sessionKey: params.sessionKey,
    continuation: nudge.goalContinuation,
    prompt: nudge.prompt,
    operatorSource,
    ...(nudge.originatingChannel && nudge.originatingTo
      ? {
          delivery: {
            channel: nudge.originatingChannel,
            to: nudge.originatingTo,
            accountId: nudge.originatingAccountId,
            threadId: nudge.originatingThreadId,
          },
        }
      : {}),
  };
  const message: PersistedUserTurnMessage = {
    role: "user",
    display: false,
    content: [{ type: "text", text: nudge.prompt }],
    timestamp: nudge.enqueuedAt,
    idempotencyKey: `${pending.runId}:user`,
    provenance: { kind: "internal_system", sourceTool: "session_goal_continue" },
    __openclaw: { goalContinuation: pending },
  };
  const recorder = createUserTurnTranscriptRecorder({
    // Pending request hashes retain undefined fields, whereas durable JSON does
    // not. Capture exactly the persisted shape before the first acceptance.
    message: parseSessionPendingInputMessage(JSON.stringify(message)),
    trackInputCompletion: true,
    target: {
      agentId: pending.agentId,
      sessionId: entry.sessionId,
      expectedSessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      sessionEntry: entry,
    },
  });
  if (
    await recorder.stageApproved!({ runId: pending.runId, assertCurrent: params.assertCurrent })
  ) {
    nudge.userTurnTranscriptRecorder = recorder;
    attachGoalContinuationPendingInputLifecycle(nudge);
  }
}
