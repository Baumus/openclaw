import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { AnyAgentTool } from "../agents/agent-tools.types.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { readPersistedFileStat } from "../agents/sessions/tools/file-write-verification.js";
import { createReadTool } from "../agents/sessions/tools/read.js";
import { createWriteTool } from "../agents/sessions/tools/write.js";
import { filterToolsByPolicy } from "../agents/tool-policy-match.js";
import { attachToolAllowlistIntersection } from "../agents/tool-policy-shared.js";
import {
  readPendingGoalContinuation,
  stageGoalContinuationPendingInput,
} from "../auto-reply/reply/goal-continuation-pending.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readGoalContinuationRecoveryPage } from "../config/sessions/session-pending-input-history.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { isMissingPathError } from "../infra/errors.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import { buildRecoveredGoalFollowup } from "./goal-continuation-recovery.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it.each([
  "source cap",
  "current policy",
  "revoked before restore",
  "revoked before effect",
] as const)(
  "restores a persisted Goal through real authentication and fences file effects: %s",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const profile = ensureProfileForEmail("goal-recovery-auth@example.test");
      const fixture = await createOperatorRecoveryFixture({
        stateDir,
        profileId: profile.id,
        context: createContext(),
        config: {},
        device: {
          deviceId: "recovery-device",
          publicKey: "fixture-public-key",
          roles: ["operator"],
          approvedScopes: ["operator.admin"],
          tokens: {
            operator: {
              token: "fixture-device-token",
              role: "operator",
              scopes: ["operator.admin"],
              createdAtMs: 1,
            },
          },
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      });
      const original = expectDefined(await fixture.restore(), "original recovered authority");
      const entry = {
        ...fixture.entry,
        goal: {
          schemaVersion: 1 as const,
          id: "goal-auth-effect",
          objective: "Verify authorized file effects",
          status: "active" as const,
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      };
      await replaceSessionEntry(fixture.target, entry);
      const goal = {
        version: 1 as const,
        runId: "goal-auth-pending",
        agentId: fixture.target.agentId,
        sessionKey: fixture.target.sessionKey,
        continuation: {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          goalId: entry.goal.id,
          executionPolicy: {},
        },
        prompt: "Continue the authorized goal",
        operatorSource: undefined,
        delivery: { channel: "telegram", to: "fixture" },
      };
      const nudge = buildRecoveredGoalFollowup({
        context: fixture.context,
        entry,
        sessionKey: fixture.target.sessionKey,
        storePath: fixture.target.storePath,
        goal,
        operatorAuthority: original.authority,
      });
      nudge.toolsAllow =
        mode === "source cap"
          ? attachToolAllowlistIntersection([], [["r*"], ["*ad"]])
          : ["read", "write"];
      try {
        await stageGoalContinuationPendingInput({
          nudge,
          entry,
          sessionKey: fixture.target.sessionKey,
          storePath: fixture.target.storePath,
          assertCurrent: () => original.authority.assertCurrent(),
        });
        const accepted = expectDefined(nudge.userTurnTranscriptRecorder, "durable Goal input");
        accepted.finishPendingInput!("interrupted");
        await accepted.waitForPendingInputSettlement!();
      } finally {
        original.release();
      }
      const page = await readGoalContinuationRecoveryPage(fixture.target);
      const persisted = expectDefined(
        page.items.find((input) => input.runId === goal.runId),
        "stored Goal JSON",
      );
      const saved = expectDefined(
        readPendingGoalContinuation(persisted.message),
        "decoded Goal policy and principal",
      );
      expect(persisted.state).toBe("interrupted");
      if (mode === "current policy") {
        fixture.setConfig({ tools: { deny: ["write"] } });
      }
      if (mode === "revoked before restore") {
        expect(
          (await rotateDeviceToken({ deviceId: "recovery-device", role: "operator" })).ok,
        ).toBe(true);
        await expect(
          restoreGatewayQueuedOperatorRecovery({
            source: saved.operatorSource,
            context: fixture.context,
            assertCurrent() {},
          }),
        ).rejects.toThrow();
        return;
      }
      const restored = await restoreGatewayQueuedOperatorRecovery({
        source: saved.operatorSource,
        context: fixture.context,
        assertCurrent() {},
      });
      const replay = buildRecoveredGoalFollowup({
        context: fixture.context,
        entry,
        sessionKey: fixture.target.sessionKey,
        storePath: fixture.target.storePath,
        goal: saved,
        operatorAuthority: restored.authority,
      });
      const client = createSyntheticPluginRuntimeClient({
        authenticatedUserProfile: fixture.client.authenticatedUserProfile,
        operatorRoleActor: { kind: "operator", profileId: restored.authority.profileId },
        operatorRunAuthority: restored.authority,
        scopes: [...restored.authority.scopes],
      });
      const run = <T>(body: () => T) =>
        withPluginRuntimeGatewayRequestScope(
          { client, context: fixture.context, isWebchatConnect: () => false },
          body,
        );
      const beforeWrite = createDeferredCore();
      const releaseWrite = createDeferredCore();
      let pauseWrite = false;
      let writes = 0;
      let pendingWrite: Promise<unknown> | undefined;
      const runId = "goal-auth-effect-run";
      const admission = prepareAgentRunAdmission({
        cfg: fixture.context.getRuntimeConfig(),
        facts: {
          runId,
          agentId: fixture.target.agentId,
          ingress: { kind: "system", boundary: "goal-recovery-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        operatorAuthority: replay.operatorAuthority,
      });
      let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
      try {
        const admittedRunContext = await run(() =>
          admission.admit("plugin-harness", `harness-${runId}`),
        );
        bindGatewayContextResolver(admittedRunContext, () => fixture.context);
        host = run(() =>
          createAgentHarnessHostCapabilities({
            attempt: {
              runId,
              agentId: fixture.target.agentId,
              sessionKey: fixture.target.sessionKey,
              sessionId: entry.sessionId,
              admittedRunContext,
              toolsAllow: replay.toolsAllow,
            },
            pluginId: "codex",
          }),
        );
        const tools: AnyAgentTool[] = [
          createReadTool(stateDir),
          createWriteTool(stateDir, {
            operations: {
              mkdir: async (dir) => {
                await mkdir(dir, { recursive: true });
                if (pauseWrite) {
                  beforeWrite.resolve();
                  await releaseWrite.promise;
                }
              },
              readFile,
              statFile: (file) => readPersistedFileStat(file, isMissingPathError),
              writeFile: async (file, content) => {
                writes++;
                await writeFile(file, content, "utf8");
              },
            },
          }),
        ];
        // Use the same concrete source-cap and current-policy owners as attempt preparation.
        const callable = host.capabilities.bindToolSurface(
          applyEmbeddedAttemptToolsAllow(
            filterToolsByPolicy(tools, fixture.context.getRuntimeConfig().tools),
            replay.toolsAllow,
          ),
        );
        const file = "goal-auth-effect.txt";
        await writeFile(path.join(stateDir, file), "original\n", "utf8");
        const reader = expectDefined(
          callable.find((tool) => tool.name === "read"),
          "allowed reader",
        );
        const read = await run(() => reader.execute("allowed-read", { path: file }));
        expect(JSON.stringify(read.content)).toContain("original");
        const writer = callable.find((tool) => tool.name === "write");
        if (mode === "source cap" || mode === "current policy") {
          expect(writer).toBeUndefined();
          expect(writes).toBe(0);
          expect(await readFile(path.join(stateDir, file), "utf8")).toBe("original\n");
          return;
        }
        const write = expectDefined(writer, "allowed writer positive control");
        await run(() => write.execute("allowed-write", { path: file, content: "allowed\n" }));
        expect(await readFile(path.join(stateDir, file), "utf8")).toBe("allowed\n");
        expect(writes).toBe(1);
        pauseWrite = true;
        pendingWrite = run(() =>
          write.execute("revoked-write", { path: file, content: "forbidden\n" }),
        );
        void pendingWrite.catch(beforeWrite.reject);
        await beforeWrite.promise;
        invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
        releaseWrite.resolve();
        await expect(pendingWrite).rejects.toThrow("no longer active");
        expect(writes).toBe(1);
        expect(await readFile(path.join(stateDir, file), "utf8")).toBe("allowed\n");
      } finally {
        releaseWrite.resolve();
        await pendingWrite?.catch(() => undefined);
        host?.close();
        admission.close();
        restored.release();
      }
    }),
);
