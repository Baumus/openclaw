import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { assertGatewayServiceUpdateCurrent } from "../../daemon/service-update-authority.js";
import { createUpdateRun, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureRestorationRisk } from "../update-cli/update-command-current-core-recovery.test-support.js";
import { runGatewayServiceUpdateCommand } from "./update-executor.js";

const mocks = vi.hoisted(() => ({ root: "/fixture-current-root", assertLease: vi.fn() }));
vi.mock("../../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => mocks.root,
}));
vi.mock("../update-cli/update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../update-cli/update-command-executor.js")>()),
  withDelegatedUpdateCommandExecutor: async (
    _grant: unknown,
    _runId: string,
    _root: string,
    work: (fence: { assertCurrent: () => void }) => Promise<unknown>,
  ) => work({ assertCurrent: mocks.assertLease }),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});
it.each(["healthy", "late-risk", "wrong-run", "install-refused", "malformed"] as const)(
  "receiver retains current-core restriction through awaited work: %s",
  async (scenario) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("receiver-risk-") };
    const run = createUpdateRun({ trigger: "cli" }, { env });
    const restriction = await captureRestorationRisk({ ...run, env });
    const input = {
      action: scenario === "install-refused" ? "install" : "restart",
      targetRoot: mocks.root,
      executor: {
        runId: run.runId,
        root: mocks.root,
        databasePath: "/lease",
        childKey: "child",
        originalChildKey: "child",
        parent: {},
        originalParent: {},
        databaseIdentity: {},
        spawner: {},
      },
      currentCoreRisk: restriction,
    };
    if (scenario === "wrong-run") {
      restriction.runId = "foreign";
    }
    if (scenario === "malformed") {
      Reflect.set(restriction.identity, "key", "missing");
    }
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      Readable.from([JSON.stringify(input)]) as typeof process.stdin,
    );
    let effects = 0;
    const promise = runGatewayServiceUpdateCommand(
      "run",
      scenario === "install-refused" ? "install" : "restart",
      async () => {
        await Promise.resolve();
        if (scenario === "late-risk") {
          recordUpdateRunVerification(
            run.runId,
            {
              recovery: {
                serviceRestartSafe: false,
                reason: "runtime-verification-failed",
                dataAtRisk: "active-mutation",
              },
            },
            { env },
          );
        }
        assertGatewayServiceUpdateCurrent();
        effects++;
      },
    );
    if (scenario === "healthy") {
      await expect(promise).resolves.toBeUndefined();
    } else {
      await expect(promise).rejects.toThrow("UPDATE_NATIVE_AUTHORITY:");
    }
    expect(effects).toBe(scenario === "healthy" ? 1 : 0);
  },
);
