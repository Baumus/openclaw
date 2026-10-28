import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createUpdateRun, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureRestorationRisk } from "./update-command-current-core-recovery.test-support.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
const mocks = vi.hoisted(() => ({ entry: vi.fn(), command: vi.fn(), child: vi.fn() }));
vi.mock("../../daemon/gateway-entrypoint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/gateway-entrypoint.js")>()),
  resolveGatewayInstallEntrypoint: mocks.entry,
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout: mocks.command,
}));
vi.mock("./update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-executor.js")>()),
  requiresRetainedUpdateCommandOwner: () => false,
  withUpdateCommandExecutorChild: mocks.child,
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.clearAllMocks();
  closeOpenClawStateDatabaseForTest();
});
it.each([
  "healthy",
  "entrypoint",
  "capability",
  "before-input",
  "old-capability",
  "native-custody-risk",
  "native-unknown-risk",
] as const)("refuses unsafe current-core activation across %s await", async (scenario) => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("command-risk-") };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  const risk = await captureRestorationRisk({ ...run, env });
  const publish = () =>
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
  let entries = 0,
    effects = 0;
  mocks.entry.mockImplementation(async () => {
    await Promise.resolve();
    if (scenario === "entrypoint" && ++entries === 1) {
      publish();
    }
    return "/fixture/index.js";
  });
  mocks.child.mockImplementation(async (_executor, _root, work) =>
    work({ runId: run.runId }, () => {}),
  );
  mocks.command.mockImplementation(async (argv, options) => {
    const check = argv.includes("check");
    await Promise.resolve();
    if (check) {
      if (scenario === "capability") {
        publish();
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          updateExecutor: "root-spawner-v1",
          targetRootBinding: true,
          ...(scenario === "old-capability" ? {} : { currentCoreRecoveryRiskGuard: true }),
        }),
        stderr: "",
        termination: "exit",
        signal: null,
        killed: false,
        cleanup: "normal",
      };
    }
    if (scenario === "before-input") {
      publish();
    }
    options.beforeInput?.(1234, argv);
    if (scenario === "native-custody-risk" || scenario === "native-unknown-risk") {
      publish();
      return {
        code: 1,
        stdout: "",
        stderr:
          scenario === "native-custody-risk"
            ? "UPDATE_NATIVE_AUTHORITY: fixture-native-custody"
            : "fixture-native-unknown",
        termination: "exit",
        signal: null,
        killed: false,
        cleanup: "normal",
      };
    }
    effects++;
    return {
      code: 0,
      stdout: JSON.stringify({ action: "restart", ok: true, result: "restarted" }),
      stderr: "",
      termination: "exit",
      signal: null,
      killed: false,
      cleanup: "normal",
    };
  });
  const promise = runUpdatedInstallGatewayCommand(
    {
      result: { root: "/fixture" },
      opts: { run: { ...run, env, executorFence: { assertCurrent() {} } } },
      invocationEnv: env,
      currentCoreRisk: risk,
    },
    "restart",
  );
  if (scenario === "healthy") {
    await expect(promise).resolves.toBe("accepted");
  } else if (scenario === "native-custody-risk") {
    await expect(promise).rejects.toThrow("fixture-native-custody");
  } else if (scenario === "native-unknown-risk") {
    await expect(promise).rejects.toThrow("fixture-native-unknown");
  } else {
    await expect(promise).rejects.toThrow();
  }
  expect(effects).toBe(scenario === "healthy" ? 1 : 0);
});
