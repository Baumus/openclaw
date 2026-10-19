import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  stageGoalContinuationPendingInput,
  type PendingGoalContinuation,
} from "../auto-reply/reply/goal-continuation-pending.js";
import { parseSessionPendingInputMessage } from "../config/sessions/session-pending-input-value.js";
import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  buildRecoveredGoalFollowup,
  recoverGoalContinuations,
} from "./goal-continuation-recovery.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";

const io = vi.hoisted(() => ({
  discover: vi.fn(),
  entries: vi.fn(),
  pending: vi.fn(),
  retained: vi.fn(),
  load: vi.fn(),
  source: vi.fn(),
  restore: vi.fn(),
  discard: vi.fn(),
  enqueue: vi.fn(),
  runner: vi.fn(),
  recorder: vi.fn(),
  readEntry: vi.fn(),
  report: vi.fn(),
}));
// mock-isolation: Storage publications and authentication are controlled at their owners; replay uses the production dispatch adapter.
vi.mock("../agents/main-session-recovery/main-session-restart-recovery-shared.js", () => ({
  discoverRestartRecoveryStoreTargets: io.discover,
}));
// mock-isolation: Existing pending-input storage owns enumeration and exact custody validation.
vi.mock("../config/sessions/session-entry-read-maintenance.js", () => ({
  readPendingInputRecoveryEntriesInWorker: io.entries,
}));
// mock-isolation: This boundary test supplies unconsumed rows without opening a database.
vi.mock("../config/sessions/session-pending-input-history.js", () => ({
  readGoalContinuationRecoveryPage: io.pending,
}));
// mock-isolation: Exact current pending custody is varied independently of discovery.
vi.mock("../config/sessions/session-pending-input-source.js", () => ({
  readPendingInputSource: io.retained,
}));
// mock-isolation: Observe retirement without writing a test database.
vi.mock("../config/sessions/session-pending-input-withdrawal.js", () => ({
  discardSessionPendingInput: io.discard,
}));
// mock-isolation: Current session publication is supplied by the recovery source owner.
vi.mock("./session-utils-store-worker.js", () => ({
  resolveGatewaySessionStoreTargetInWorker: io.load,
}));
// mock-isolation: Model reset/pause while authentication awaits without a Gateway projection runtime.
vi.mock("./session-recovery-source.js", () => ({ prepareRecoverySource: io.source }));
// mock-isolation: Authentication success/revocation remains an independently controlled boundary.
vi.mock("./operator-run-recovery.js", () => ({ restoreGatewayQueuedOperatorRecovery: io.restore }));

// mock-isolation: Observe the real queue admission adapter; multi-turn draining belongs to the Gateway Goal product test.
vi.mock("../auto-reply/reply/queue/enqueue.js", () => ({
  enqueueFollowupRun: io.enqueue,
  getFollowupQueueDepth: () => 0,
}));
// mock-isolation: Keep the production followup-owner choice visible without a model request.
vi.mock("../auto-reply/reply/followup-runner.js", () => ({ createFollowupRunner: io.runner }));
// mock-isolation: Pending storage promotion is covered by the SQLite worker custody tests.
vi.mock("../sessions/user-turn-transcript.js", () => ({
  createUserTurnTranscriptRecorder: io.recorder,
}));

// mock-isolation: Validate a fresh session observation independently from startup enumeration.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: io.readEntry,
}));
// mock-isolation: Observe visible failure notices without transcript I/O.
vi.mock("../config/sessions/session-accessor.sqlite-transcript-reports.js", () => ({
  appendSessionTranscriptReport: io.report,
}));

const goal: PendingGoalContinuation = {
  version: 1,
  runId: "goal-nudge",
  agentId: "main",
  sessionKey: "agent:main:test",
  continuation: { sessionId: "session-1", lifecycleRevision: "revision-1", goalId: "goal-1" },
  prompt: "Advance the active goal",
  operatorSource: { kind: "fixture" },
};
const input: SessionPendingInput = {
  id: "pending-1",
  runId: goal.runId,
  acceptedAt: 1,
  state: "interrupted",
  message: {
    role: "user",
    timestamp: 1,
    content: goal.prompt,
    display: false,
    idempotencyKey: `${goal.runId}:user`,
    provenance: { kind: "internal_system", sourceTool: "session_goal_continue" },
    __openclaw: { goalContinuation: goal },
  },
};
let entry: SessionEntry;
const config = {};
const dispatch = vi.fn();
const recorder = {
  stageApproved: vi.fn(async () => true),
  finishPendingInput: vi.fn(),
  waitForPendingInputSettlement: vi.fn(async () => {}),
};
const release = vi.fn();
const context = createDirectChatContext({
  getRuntimeConfig: () => config,
  recoveryRuntime: createMockGatewayRecoveryRuntime({ dispatchAgent: dispatch }),
});
context.logGateway.warn = vi.fn();
beforeEach(() => {
  resetGatewayWorkAdmission();
  vi.clearAllMocks();
  entry = {
    sessionId: "session-1",
    lifecycleRevision: "revision-1",
    updatedAt: 1,
    agentHarnessId: "codex",
    goal: {
      schemaVersion: 1,
      id: "goal-1",
      objective: "Finish",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    },
  };
  io.discover.mockResolvedValue([{ agentId: "main", storePath: "/fixture/sessions.sqlite" }]);
  io.entries.mockResolvedValue([{ sessionKey: goal.sessionKey, entry }]);
  io.pending.mockResolvedValue({ items: [input] });
  io.retained.mockResolvedValue({
    assertCurrent() {},
    snapshot: {
      current: true,
      pending: {
        input_id: input.id,
        state: "interrupted",
        consumed_event_id: null,
        message_json: JSON.stringify(input.message),
      },
    },
  });
  io.load.mockResolvedValue({});
  io.source.mockResolvedValue({
    current: () => entry,
    refresh: async () => entry,
    [Symbol.dispose]() {},
  });
  io.restore.mockResolvedValue({ authority: {}, release });
  io.readEntry.mockImplementation(async () => entry);
  io.report.mockResolvedValue({ ok: true });
  io.recorder.mockReturnValue(recorder);
  io.runner.mockReturnValue(dispatch);
  io.enqueue.mockReturnValue(true);
});
afterEach(() => resetGatewayWorkAdmission());

it("hashes the producer's durable JSON shape including absent nested optional fields", async () => {
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "profile",
    scopes: ["operator.read"],
    assertCurrent() {},
    recoverySnapshot: {
      profileId: "profile",
      scopes: ["operator.read"],
      assignedRole: null,
      githubLogin: null,
      grant: null,
      aliasBindingIds: [],
      authPolicy: {
        generation: "",
        grantGeneration: "fixture",
        role: "operator",
        authMethod: "token",
      },
      controlUiAdmin: true,
      localOperator: true,
      sourceIngress: "internal",
      modelPolicy: undefined,
    },
  });
  const nudge = buildRecoveredGoalFollowup({
    context,
    entry,
    sessionKey: goal.sessionKey,
    operatorAuthority: authority,
    goal: {
      ...goal,
      continuation: { ...goal.continuation, lifecycleRevision: undefined },
      delivery: { channel: "webchat", to: "fixture", accountId: undefined, threadId: undefined },
    },
  });
  await stageGoalContinuationPendingInput({
    nudge,
    entry,
    sessionKey: goal.sessionKey,
    storePath: "/fixture/sessions.sqlite",
    assertCurrent() {},
  });
  const message = io.recorder.mock.calls[0]![0].message;
  expect(message).toStrictEqual(parseSessionPendingInputMessage(JSON.stringify(message)));
  expect(message["__openclaw"].goalContinuation.delivery).toStrictEqual({
    channel: "webchat",
    to: "fixture",
  });
  expect(message["__openclaw"].goalContinuation.continuation).not.toHaveProperty(
    "lifecycleRevision",
  );
});

it.each([false, true])(
  "settles replay custody when queue ownership ends (restart=%s)",
  async (restart) => {
    await recoverGoalContinuations(context, new AbortController().signal);
    const queued = io.enqueue.mock.calls[0]![1];
    if (restart) {
      markGatewayRestartDraining();
    }
    await queued.turnAdoptionLifecycle.onAbandoned();
    await queued.turnAdoptionLifecycle.onSettled();
    expect(recorder.finishPendingInput).toHaveBeenCalledExactlyOnceWith(
      restart ? "interrupted" : "cancelled",
    );
    expect(recorder.waitForPendingInputSettlement).toHaveBeenCalledOnce();
  },
);

it("settles an input skipped before adoption even when the source is consumed", async () => {
  await recoverGoalContinuations(context, new AbortController().signal);
  await io.enqueue.mock.calls[0]![1].turnAdoptionLifecycle.onSettled();
  expect(recorder.finishPendingInput).toHaveBeenCalledExactlyOnceWith("cancelled");
});

it("restores the exact admitted Goal input and its operator before normal dispatch", async () => {
  await recoverGoalContinuations(context, new AbortController().signal);
  expect(io.enqueue).toHaveBeenCalledOnce();
  expect(io.enqueue.mock.calls[0]![1]).toMatchObject({
    messageId: goal.runId,
    goalContinuation: goal.continuation,
    userTurnTranscriptRecorder: recorder,
  });
  expect(io.recorder.mock.calls[0]![0].message).toEqual(input.message);
  expect(io.enqueue.mock.calls[0]![4]).toBe(dispatch);
  expect(io.restore).toHaveBeenCalledWith(expect.objectContaining({ source: goal.operatorSource }));
  expect(release).toHaveBeenCalledOnce();
});

it.each(["paused", "complete"] as const)("retires a %s Goal without dispatch", async (status) => {
  entry.goal!.status = status;
  await recoverGoalContinuations(context, new AbortController().signal);
  expect(io.enqueue).not.toHaveBeenCalled();
  expect(io.discard).toHaveBeenCalledOnce();
});

it("does not replay a consumed pending input", async () => {
  io.retained.mockResolvedValue({ snapshot: { current: true } });
  await recoverGoalContinuations(context, new AbortController().signal);
  expect(io.enqueue).not.toHaveBeenCalled();
});

it("rechecks a Goal paused while operator restoration awaited", async () => {
  io.restore.mockImplementation(async () => {
    entry.goal!.status = "paused";
    return { authority: {}, release };
  });
  await recoverGoalContinuations(context, new AbortController().signal);
  expect(context.logGateway.warn).toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

it("never dispatches when operator restoration is revoked", async () => {
  io.restore.mockRejectedValue(new Error("operator access revoked"));
  await recoverGoalContinuations(context, new AbortController().signal);
  expect(io.enqueue).not.toHaveBeenCalled();
  expect(context.logGateway.warn).toHaveBeenCalledOnce();
});
