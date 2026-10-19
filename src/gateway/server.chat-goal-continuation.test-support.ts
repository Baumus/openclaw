import { expect, it, vi, type MockInstance } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import { registerAgentHarness, getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { discoverRestartRecoveryStoreTargets } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import * as runtimePlugins from "../agents/runtime-plugins.js";
import { stageGoalContinuationPendingInput } from "../auto-reply/reply/goal-continuation-pending.js";
import * as followupQueue from "../auto-reply/reply/queue/enqueue.js";
import * as replyPreparation from "../auto-reply/reply/reply-agent-turn-preparation.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readPendingInputRecoveryEntriesInWorker } from "../config/sessions/session-entry-read-maintenance.js";
import { readGoalContinuationRecoveryPage } from "../config/sessions/session-pending-input-history.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  buildRecoveredGoalFollowup,
  recoverGoalContinuations,
} from "./goal-continuation-recovery.js";
import * as operatorRecovery from "./operator-run-recovery.js";
import type { GatewayRequestContext, GatewayClient, RespondFn } from "./server-methods/types.js";
import { onceMessage, prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";

/** Reuse the suite's admission, queue and reply owners; only provider execution is simulated. */
export function registerGoalAutomaticContinuationCases(
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string },
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>,
  rpc: (
    method: "chat.send" | "sessions.abort",
    params: Record<string, unknown>,
    onResponse?: RespondFn,
    client?: GatewayClient,
  ) => Promise<MockInstance<RespondFn>>,
  goalStart: (message: string) => Record<string, unknown>,
  userMessages: () => readonly unknown[],
  client: GatewayClient,
  liveGateway: () => Promise<{
    context: GatewayRequestContext;
    ws: WebSocket;
    [Symbol.asyncDispose](): Promise<void>;
  }>,
) {
  it("replays an accepted pending Goal through consecutive followup turns and delivers to attached WebChat", async () => {
    await using live = await liveGateway();
    using enqueue = vi.spyOn(followupQueue, "enqueueFollowupRun");
    using prepare = vi.spyOn(replyPreparation, "prepareReplyAgentTurn");
    using warn = vi.spyOn(live.context.logGateway, "warn");
    const identity = scope();
    const savedGoal = {
      schemaVersion: 1 as const,
      id: "recovered-goal",
      objective: "Finish after restart",
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    };
    await patchSessionEntryCore(identity, () => ({ goal: savedGoal }));
    const entry = loadSessionEntry(identity)!;
    const runId = "recovered-goal-input";
    const prompt = "Advance the active goal";
    let holds = 1;
    const recoveryProfile = ensureProfileForEmail("goal-recovery@example.test");
    const authority = createAdmittedRunOperatorAuthority({
      profileId: recoveryProfile.id,
      scopes: ["operator.read", "operator.write", "operator.admin"],
      recoverySnapshot: {
        profileId: recoveryProfile.id,
        scopes: ["operator.read", "operator.write", "operator.admin"],
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
      assertCurrent() {
        if (holds <= 0) {
          throw new Error("recovery authority released");
        }
      },
      retain() {
        holds++;
        return () => {
          holds--;
        };
      },
    });
    const nudge = buildRecoveredGoalFollowup({
      context: live.context,
      entry,
      sessionKey: identity.sessionKey,
      storePath: identity.storePath,
      operatorAuthority: authority,
      goal: {
        version: 1,
        runId,
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        continuation: {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          goalId: savedGoal.id,
          executionPolicy: {},
        },
        prompt,
        operatorSource: undefined,
      },
    });
    await stageGoalContinuationPendingInput({ nudge, entry, ...identity, assertCurrent() {} });
    const accepted = nudge.userTurnTranscriptRecorder;
    expect(accepted).toBeDefined();
    accepted!.finishPendingInput!("interrupted");
    await accepted!.waitForPendingInputSettlement!();
    const targets = await discoverRestartRecoveryStoreTargets({
      cfg: live.context.getRuntimeConfig(),
    });
    const target = targets.find((candidate) => candidate.storePath === identity.storePath);
    expect(target, "restart inventory must discover the accepted input's store").toBeDefined();
    expect(await readPendingInputRecoveryEntriesInWorker(target!)).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionKey: identity.sessionKey })]),
    );
    expect((await readGoalContinuationRecoveryPage(identity)).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId, state: "interrupted" })]),
    );
    using restored = vi
      .spyOn(operatorRecovery, "restoreGatewayQueuedOperatorRecovery")
      .mockResolvedValue({
        authority,
        controlUiAdmin: true,
        release: () => {
          holds--;
        },
      });
    runEmbeddedAgent.mockImplementation(async (params) => {
      if (runEmbeddedAgent.mock.calls.length === 2) {
        await patchSessionEntryCore(identity, (current) => ({
          goal: current.goal ? { ...current.goal, status: "complete" } : undefined,
        }));
      }
      return {
        payloads: [{ text: `Advance verified ${runEmbeddedAgent.mock.calls.length}` }],
        meta: {
          durationMs: 0,
          stopReason: "end_turn",
          agentMeta: {
            sessionId: params.sessionId,
            provider: "test",
            model: "test",
            usage: { input: 1, output: 1 },
          },
        },
      };
    });
    const delivered = onceMessage(
      live.ws,
      (frame) =>
        frame.event === "chat" &&
        frame.payload?.sessionKey === identity.sessionKey &&
        frame.payload?.state === "final" &&
        (JSON.stringify(frame.payload.message) ?? "").includes("Advance verified 2"),
      20_000,
    );
    void delivered.catch(() => {});
    await recoverGoalContinuations(live.context, new AbortController().signal);
    expect(restored, "recovery must restore accepted input authority").toHaveBeenCalledOnce();
    expect(
      warn.mock.calls,
      "recovery must accept the persisted input without an admission failure",
    ).toEqual([]);
    expect(enqueue).toHaveReturnedWith(true);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled(), { timeout: 5_000 });
    await vi.waitFor(
      () =>
        expect(prepare.mock.settledResults[0]).toMatchObject({
          type: "fulfilled",
          value: { kind: "admitted" },
        }),
      { timeout: 5_000 },
    );
    await vi.waitFor(() => expect(runEmbeddedAgent).toHaveBeenCalledTimes(2), {
      timeout: 15_000,
    });
    expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(restored).toHaveBeenCalledOnce();
    expect(loadSessionEntry(identity)?.goal?.status).toBe("complete");
    expect((await delivered).payload).toMatchObject({
      state: "final",
      sessionKey: identity.sessionKey,
      message: {
        role: "assistant",
        content: expect.arrayContaining([{ type: "text", text: "Advance verified 2" }]),
      },
    });
    await recoverGoalContinuations(live.context, new AbortController().signal);
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
  });

  it.each(["openclaw", "codex"])(
    "nudges consecutive %s final turns until the same Goal is complete",
    async (harnessId) => {
      using loadNative = vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle");
      if (harnessId === "codex") {
        registerAgentHarness({
          id: "codex",
          label: "Codex fixture",
          supports: () => ({ supported: true, priority: 100 }),
          runAttempt: async () => {
            throw new Error("provider transport is simulated");
          },
        });
        getTestPluginRegistry().agentHarnesses.push({
          pluginId: "codex",
          source: "fixture",
          harness: getRegisteredAgentHarness("codex")!.harness,
        });
        loadNative.mockReturnValue(getTestPluginRegistry());
        const baseline = getRuntimeConfig();
        await prepareGatewayReplyRuntimeForTest({
          force: true,
          config: {
            ...baseline,
            plugins: {
              ...baseline.plugins,
              entries: { ...baseline.plugins?.entries, codex: { enabled: true } },
            },
            agents: {
              ...baseline.agents,
              entries: {
                ...baseline.agents?.entries,
                main: { ...baseline.agents?.entries?.main, nativeRuntimeConsent: ["codex"] },
              },
            },
          },
        });
        await patchSessionEntryCore(scope(), () => ({
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        }));
      }
      const completed = createDeferred();
      runEmbeddedAgent.mockImplementation(async (params) => {
        const calls = runEmbeddedAgent.mock.calls.length;
        if (calls === 3) {
          await patchSessionEntryCore(scope(), (entry) => ({
            goal: entry.goal ? { ...entry.goal, status: "complete" } : undefined,
          }));
          completed.resolve();
        }
        return {
          payloads: [{ text: calls === 3 ? "Verified the goal." : "More work remains." }],
          meta: {
            durationMs: 0,
            stopReason: "end_turn",
            agentMeta: {
              sessionId: params.sessionId,
              provider: "test",
              model: "test",
              usage: { input: 1, output: 1 },
            },
          },
        };
      });
      const profile =
        harnessId === "codex" ? ensureProfileForEmail("local-codex-goal@example.test") : undefined;
      const operator = profile
        ? {
            ...client,
            authenticatedUserProfile: {
              profileId: profile.id,
              displayName: null,
              hasAvatar: false,
              updatedAt: 1,
            },
          }
        : client;
      const started = await rpc(
        "chat.send",
        goalStart("Finish a three-turn checklist"),
        undefined,
        operator,
      );
      expect(started.mock.calls[0]?.[0]).toBe(true);
      await completed.promise;
      const drained = await waitForGatewayActiveWork(30_000);
      expect(drained.drained).toBe(true);
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(3);
      expect(runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain("Advance");
      expect(runEmbeddedAgent.mock.calls[2]?.[0].prompt).toContain("Advance");
      expect(userMessages()).toHaveLength(1);
      expect(loadSessionEntry(scope())?.goal).toMatchObject({
        status: "complete",
        continuationTurns: 2,
      });
    },
  );

  it("stops automatic goal pursuit when the operator stops a continuation", async () => {
    const { sessionKey } = scope();
    const secondStarted = createDeferred();
    const released = createDeferred();
    let continuationSignal: AbortSignal | undefined;
    let continuationRunId: string | undefined;
    runEmbeddedAgent.mockImplementation(async (params) => {
      const second = runEmbeddedAgent.mock.calls.length === 2;
      if (second) {
        continuationRunId = params.runId;
        const runtimeAbort = new AbortController();
        continuationSignal = params.abortSignal
          ? AbortSignal.any([params.abortSignal, runtimeAbort.signal])
          : runtimeAbort.signal;
        const abort = () => {
          runtimeAbort.abort();
          released.resolve();
        };
        // The model is mocked; preserve the runtime's real Stop registration boundary.
        const backend = {
          kind: "embedded" as const,
          runId: params.runId,
          cancel: abort,
          abort,
          isStreaming: () => !runtimeAbort.signal.aborted,
          isAborted: () => runtimeAbort.signal.aborted,
          isCompacting: () => false,
          queueMessage: async () => {},
        };
        params.replyOperation?.attachBackend(backend);
        attachActiveEmbeddedRun(
          params.sessionId,
          backend,
          sessionKey,
          params.sessionFile,
          "main",
          params.replyOperation,
        );
        secondStarted.resolve();
        try {
          await released.promise;
        } finally {
          detachActiveEmbeddedRun(params.sessionId, backend, sessionKey, params.sessionFile);
          params.replyOperation?.detachBackend(backend);
        }
      }
      const aborted = continuationSignal?.aborted === true;
      return {
        payloads: aborted ? [] : [{ text: "The goal is not complete yet." }],
        meta: {
          durationMs: 0,
          stopReason: aborted ? "aborted" : "end_turn",
          aborted,
          agentMeta: {
            sessionId: params.sessionId,
            provider: "test",
            model: "test",
            usage: { input: 1, output: 1 },
          },
        },
      };
    });
    const started = await rpc("chat.send", goalStart("Keep working until stopped"));
    expect(started.mock.calls[0]?.[0]).toBe(true);
    try {
      await secondStarted.promise;
      const stopped = await rpc("sessions.abort", { key: sessionKey, runId: continuationRunId });
      expect(stopped.mock.calls[0]?.[0]).toBe(true);
      expect(continuationSignal?.aborted).toBe(true);
    } finally {
      if (continuationSignal?.aborted !== true) {
        await patchSessionEntryCore(scope(), (entry) => ({
          goal: entry.goal ? { ...entry.goal, status: "paused" } : undefined,
        }));
      }
      released.resolve();
    }
    const drained = await waitForGatewayActiveWork(30_000);
    expect(drained.drained).toBe(true);
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry(scope())?.goal?.status).toBe("active");
  });
}
