import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawPluginToolFactory } from "../plugins/types.js";
import { GatewayClient } from "./client.js";
import {
  CLI_ANNOUNCE_BARRIER_TOOL_NAME,
  createCliBackendProbePlugin,
  verifyCliBackendAnnounceOrdering,
} from "./gateway-cli-backend.live-cache.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps the CLI announcement controller barrier out of child tools", async () => {
  const { pluginPath } = await createCliBackendProbePlugin(tempDirs.make("cli-announce-scope-"), {
    mcpSchema: false,
    announceBarrierUrl: "http://127.0.0.1:1/unused",
  });
  const registrations: Array<AnyAgentTool | OpenClawPluginToolFactory> = [];
  const require = createRequire(import.meta.url);
  const plugin: {
    register(api: { registerTool(tool: AnyAgentTool | OpenClawPluginToolFactory): void }): void;
  } = require(path.join(pluginPath, "index.cjs"));
  plugin.register({ registerTool: (tool) => registrations.push(tool) });
  const toolsFor = (sessionKey: string) =>
    registrations.flatMap((registration) => {
      const tools =
        typeof registration === "function" ? registration({ sessionKey }) : registration;
      return tools ? (Array.isArray(tools) ? tools : [tools]) : [];
    });
  expect(toolsFor("agent:dev:cli-announce-proof").map((tool) => tool.name)).toEqual([
    CLI_ANNOUNCE_BARRIER_TOOL_NAME,
  ]);
  expect(toolsFor("agent:dev:subagent:proof")).toEqual([]);
});

const announceMocks = vi.hoisted(() => ({ history: vi.fn(), runs: vi.fn() }));

// mock-isolation: Exercise the verifier without real transcript storage.
vi.mock("../agents/cli-runner/session-history.js", () => ({
  loadCliSessionHistoryMessages: announceMocks.history,
}));
// mock-isolation: Supply independent execution and delivery receipts to the verifier.
vi.mock("../agents/subagents/registry/subagent-registry.test-helpers.js", () => ({
  listSubagentRunsForRequester: announceMocks.runs,
}));
// mock-isolation: The synthetic transcript has no persisted session or database.
vi.mock("./session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: () => ({ entry: { sessionId: "announce-test" } }),
}));
// mock-isolation: Storage identity resolution is outside the verifier contract.
vi.mock("../config/sessions/session-accessor.js", () => ({
  resolveSessionTranscriptRuntimeTarget: async () => ({ sessionId: "announce-test" }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  announceMocks.history.mockReset();
  announceMocks.runs.mockReset();
});

it.each([
  { name: "selects the later completion after a parent mentioning both markers", early: false },
  { name: "rejects actual delivery before the parent despite ordered history", early: true },
])("$name", async ({ early }) => {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  const parent = createDeferred<{ result: { payloads: Array<{ text: string }> } }>();
  const client = new GatewayClient({ url: "ws://127.0.0.1:1", deviceIdentity: null });
  const request = vi.spyOn(client, "request").mockReturnValue(parent.promise);
  const historyRead = createDeferred();
  const resumeHistory = createDeferred();
  let released = false;
  let parentToken = "";
  let childToken = "";
  announceMocks.runs.mockImplementation((sessionKey: string) => {
    const nonce = sessionKey.split("-").at(-1)!;
    parentToken = "CLI_ANNOUNCE_PARENT_" + nonce.toUpperCase();
    childToken = "CLI_ANNOUNCE_CHILD_" + nonce.toUpperCase();
    return [
      createSubagentRunRecord({
        runId: "announce-run",
        taskName: "cli_announce_" + nonce,
        endedAt: 50,
        outcome: { status: "ok" },
        completion: { required: true, resultText: childToken },
        delivery: released
          ? { status: "delivered", deliveredAt: early ? 99 : 101, announcedAt: early ? 99 : 101 }
          : { status: "pending" },
      }),
    ];
  });
  const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
  const bothMarkers = () => message(parentToken + " (child will return " + childToken + ")");
  announceMocks.history.mockImplementationOnce(async () => [bothMarkers()]);
  announceMocks.history.mockImplementationOnce(async () => {
    historyRead.resolve();
    await resumeHistory.promise;
    return [bothMarkers(), message(childToken)];
  });
  const logStep = vi.fn();
  const proof = verifyCliBackendAnnounceOrdering({
    client,
    announceBarrier: {
      url: "http://127.0.0.1:1/unused",
      calls: 1,
      release() {
        released = true;
        parent.resolve({ result: { payloads: [{ text: parentToken + " " + childToken }] } });
      },
      close: async () => {},
    },
    requestTimeoutMs: 1_000,
    logStep,
  });
  if (early) {
    await expect(proof).rejects.toThrow("greater than or equal to 100");
    expect(announceMocks.history).not.toHaveBeenCalled();
    return;
  }
  void proof.catch(() => {});
  await vi.advanceTimersByTimeAsync(1_000);
  await awaitGateBeforeSettlement(
    historyRead.promise,
    proof,
    "parent-only history qualified as completion",
  );
  // Parent-only history must not qualify, even when it mentions the child.
  expect(logStep).not.toHaveBeenCalledWith("announce-child:transcript-order", expect.anything());
  resumeHistory.resolve();
  await expect(proof).resolves.toBeUndefined();
  expect(logStep).toHaveBeenCalledWith(
    "announce-child:transcript-order",
    expect.objectContaining({
      parentReplyIndex: 0,
      completionReplyIndex: 1,
    }),
  );
  expect(request).toHaveBeenCalledOnce();
});
