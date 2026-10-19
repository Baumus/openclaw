import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  bindGoalContinuationExecution,
  promoteGoalContinuationYield,
  withGoalContinuationSettlement,
  prepareGoalContinuationContext,
  readGoalContinuationContext,
  revokeGoalContinuationReturn,
} from "./goal-continuation-return.js";

/** Simulate execution/yield publications, leaving return-scope creation to the real caller. */
export function createGoalChildReturnFixture(params: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  harnessId: string;
}) {
  const entry: SessionEntry = {
    sessionId: params.sessionId,
    updatedAt: Date.now(),
    agentHarnessId: params.harnessId,
    goal: {
      schemaVersion: 1,
      id: "caller-goal",
      status: "active",
      objective: "Finish the caller goal",
      createdAt: 1,
      updatedAt: 1,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    },
  };
  const child: SubagentRunRecord = {
    runId: "caller-child",
    childSessionKey: "agent:main:subagent:caller-child",
    childAgentId: params.agentId,
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.agentId,
    requesterDisplayKey: params.sessionKey,
    task: "Verify one item",
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
    completionRequesterSessionId: params.sessionId,
    requesterSettleWake: {
      status: "dispatching",
      attemptCount: 1,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: ["caller-child"],
    },
  };
  return {
    entry,
    yield(runId: string) {
      bindGoalContinuationExecution(runId, params.sessionKey);
      promoteGoalContinuationYield({
        requesterTurnRunId: runId,
        entries: [child],
        rearmGeneration: 1,
      });
    },
    readReturnedContext() {
      return withGoalContinuationSettlement(
        [child],
        "caller-child-settlement",
        () => true,
        () => {
          prepareGoalContinuationContext({
            runId: "caller-child-settlement",
            sessionKey: params.sessionKey,
            sessionEntry: entry,
          });
          return readGoalContinuationContext({
            runId: "caller-child-settlement",
            sessionKey: params.sessionKey,
          });
        },
      );
    },
    close() {
      revokeGoalContinuationReturn(child);
    },
  };
}
