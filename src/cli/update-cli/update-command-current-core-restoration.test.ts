import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gatewayService from "../../daemon/service.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { defaultRuntime } from "../../runtime.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
import { POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON } from "./update-command-post-plugin-validation.js";
import { successfulPluginUpdate } from "./update-command-post-update.test-support.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

const mocks = vi.hoisted(() => ({
  activePort: vi.fn<typeof import("../../infra/gateway-lock.js").readActiveGatewayLockPort>(
    async () => undefined,
  ),
  managedService: vi.fn<
    typeof import("./update-command-service-plan.js").readManagedGatewayServiceForUpdate
  >(async () => null),
  converge: vi.fn<typeof import("./update-command-convergence.js").convergeUpdatePlugins>(),
  printResult: vi.fn(),
  task: vi.fn<typeof import("../../daemon/schtasks-exec.js").execSchtasks>(),
}));
// Native Windows transport only; the finalizer and autostart recovery owner stay real.
vi.mock("../../daemon/schtasks-exec.js", async () => ({
  ...(await vi.importActual<typeof import("../../daemon/schtasks-exec.js")>(
    "../../daemon/schtasks-exec.js",
  )),
  execSchtasks: mocks.task,
  execScheduledTaskEnabledChange: (name: string, enabled: boolean) =>
    mocks.task(["/Change", "/TN", name, enabled ? "/ENABLE" : "/DISABLE"]),
}));
vi.mock("./update-command-convergence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-convergence.js")>()),
  convergeUpdatePlugins: mocks.converge,
}));
vi.mock("./progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./progress.js")>()),
  printResult: mocks.printResult,
}));
vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: mocks.activePort,
}));
vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  readManagedGatewayServiceForUpdate: mocks.managedService,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.converge.mockReset();
  mocks.task.mockReset();
  mocks.activePort.mockReset();
  mocks.managedService.mockReset();
  vi.mocked(verifyUpdatedGateway)
    .mockReset()
    .mockResolvedValue({ ok: false, score: 0, summary: "stopped-free" });
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("failure-recovery-state-"));
  root = dirs.make("failure-recovery-package-");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
  );
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  ...(["linux", "win32"] as const).flatMap((platform) =>
    [false, true].map((dataAtRisk) => ({ platform, dataAtRisk, failure: "doctor" as const })),
  ),
  // Readiness lint (#184727) and the target finalizer's pre-plugin Doctor (#171435)
  // fail after the same Doctor park; only final recovery restarts the latter.
  { platform: "linux" as const, dataAtRisk: false, failure: "lint" as const },
  { platform: "linux" as const, dataAtRisk: false, failure: "fresh-finalizer" as const },
  ...(
    [
      "recorded-risk",
      "ledger-unreadable",
      "no-restart",
      "mutation",
      "mutation-disallowed",
      "foreign",
      "late-risk-service-read",
      "late-risk-port",
      "late-risk-unknown",
      "late-risk-custody",
    ] as const
  ).map((fence) => ({
    platform: "linux" as const,
    dataAtRisk: false,
    failure: "fresh-finalizer" as const,
    fence,
  })),
])(
  "recovers a Gateway after a failed $failure on $platform unless data is at risk ($dataAtRisk), fence=$fence",
  async (scenario) => {
    const { platform, dataAtRisk, failure } = scenario;
    const fence = "fence" in scenario ? scenario.fence : undefined;
    const [
      { createMockGatewayService },
      { withUpdateCommandExecutor },
      { createPostUpdateRepairFixture },
      { finishUpdate },
      serviceCommand,
      serviceMaintenance,
      servicePlan,
      serviceOperations,
      { createWindowsTaskAutoStartRecovery },
      nodeSqlite,
      processIdentity,
      snapshotStaging,
    ] = await Promise.all([
      import("../../daemon/service.test-helpers.js"),
      import("./update-command-executor.js"),
      import("./update-command-post-update-repair.test-support.js"),
      import("./update-command-post-update.js"),
      import("./update-command-service-command.js"),
      import("./update-command-service-maintenance.js"),
      import("./update-command-service-plan.js"),
      import("./update-command-service.js"),
      import("./update-command-windows-task.js"),
      import("../../infra/node-sqlite.js"),
      import("../../shared/pid-alive.js"),
      import("../../infra/sqlite-snapshot-staging.js"),
    ]);
    const hostPlatform = process.platform;
    const existingUri = nodeSqlite.resolveExistingSqliteFileUri;
    vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((pathname) =>
      existingUri(pathname, hostPlatform),
    );
    const servicePlatform = vi.spyOn(process, "platform", "get").mockReturnValue(hostPlatform);
    // Native process identity and SQLite staging still belong to the real host.
    const onHost = <T>(read: () => T): T => {
      const activePlatform = process.platform;
      servicePlatform.mockReturnValue(hostPlatform);
      try {
        return read();
      } finally {
        servicePlatform.mockReturnValue(activePlatform);
      }
    };
    const readStart = processIdentity.getFileLockProcessStartTime;
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((...args) =>
      onHost(() => readStart(...args)),
    );
    const createStaging = snapshotStaging.createSqliteSnapshotStagingDirectorySync;
    vi.spyOn(snapshotStaging, "createSqliteSnapshotStagingDirectorySync").mockImplementation(
      (...args) => onHost(() => createStaging(...args)),
    );
    const params = createPostUpdateRepairFixture(root);
    const run = params.opts.run!;
    params.root = root;
    params.result = {
      ...params.result,
      root,
      status: "skipped",
      reason: "already-current",
      before: { version: "2026.9.5" },
      after: { version: "2026.9.5" },
    };
    params.coreAlreadyCurrent = true;
    params.mutationStarted = false;
    params.rollbackBlockedReason = undefined;
    params.preManagedServiceStop!.stopped = false;
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "dist/index.js"), "export {};\n");
    let running = true;
    let enabled = true;
    let lateRiskPublished = false;
    const publishLateRisk = () => {
      lateRiskPublished = true;
      updateLedger.recordUpdateRunVerification(
        run.runId,
        {
          recovery: {
            serviceRestartSafe: false,
            reason: "runtime-verification-failed",
            dataAtRisk: "active-mutation",
          },
        },
        { env: run.env },
      );
    };
    mocks.task.mockImplementation(async (args) => {
      if (args[0] === "/Query") {
        return {
          code: 0,
          stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
          stderr: "",
        };
      }
      if (args[0] === "/Run") {
        if (enabled) {
          running = true;
        }
        return { code: enabled ? 0 : 1, stdout: "", stderr: "" };
      }
      enabled = args.at(-1) === "/ENABLE";
      return { code: 0, stdout: "", stderr: "" };
    });
    const state = () => ({
      installed: true,
      loadState: { status: "loaded" as const },
      running,
      runtime: {
        status: running ? ("running" as const) : ("stopped" as const),
        pid: running ? 4321 : undefined,
        ...(platform === "linux" ? { systemd: { managerUid: 2001 } } : {}),
      },
      env: run.env,
      command: {
        programArguments: [process.execPath, path.join(root, "dist/index.js"), "gateway"],
        ...(platform === "win32" ? { sourcePath: path.join(root, "gateway.cmd") } : {}),
      },
    });
    vi.spyOn(servicePlan, "readGatewayServiceStateForUpdate").mockImplementation(async () => {
      if (fence === "late-risk-service-read" && !running && !lateRiskPublished) {
        publishLateRisk();
      }
      if (
        (fence === "late-risk-unknown" || fence === "late-risk-custody") &&
        !running &&
        !lateRiskPublished
      ) {
        publishLateRisk();
        if (fence === "late-risk-custody") {
          const { UpdateCommandRecoveryPendingError } =
            await import("./update-command-recovery-error.js");
          throw new UpdateCommandRecoveryPendingError("fixture-native-custody-lost");
        }
        throw new Error("fixture-unknown-restoration-error");
      }
      return state();
    });
    if (fence === "late-risk-port") {
      const resolvePort = servicePlan.resolveUpdatedGatewayRestartPort;
      vi.spyOn(servicePlan, "resolveUpdatedGatewayRestartPort").mockImplementation(
        async (...args) => {
          const port = await resolvePort(...args);
          if (!running && !lateRiskPublished) {
            publishLateRisk();
          }
          return port;
        },
      );
    }
    vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(
      createMockGatewayService({
        readRuntime: async () => state().runtime,
      }),
    );
    const stop = vi
      .spyOn(serviceOperations, "maybeStopManagedServiceBeforeMutableUpdate")
      .mockImplementation(async ({ onStopped }) => {
        const recovery =
          platform === "win32"
            ? createWindowsTaskAutoStartRecovery({ serviceEnv: run.env })
            : undefined;
        await recovery?.suspended;
        running = false;
        const stopped = {
          ...params.preManagedServiceStop!,
          stopped: true,
          windowsTaskAutoStartRecovery: recovery,
        };
        onStopped?.(stopped);
        return stopped;
      });
    const facts = Array.from({ length: 4 }, (_, index) => ({
      check: `fixture-check-${index + 1}`,
      code: "step-refused",
    }));
    if (dataAtRisk) {
      // Baseline Doctor throws data-at-risk refusals instead of reporting a result.
      mocks.converge.mockImplementationOnce(async ({ beforeDoctor }) => {
        await beforeDoctor?.();
        throw new DoctorMaintenanceRefusalError(
          "Doctor refused maintenance.",
          { kind: "data-at-risk", reason: "unreadable-state" },
          { failureFacts: facts },
        );
      });
    } else {
      mocks.converge.mockImplementationOnce(async ({ beforeDoctor, result }) => {
        await beforeDoctor?.();
        return {
          resultWithPostUpdate: {
            ...result,
            status: "error",
            reason:
              failure === "fresh-finalizer" ? "post-core-update-failed" : "post-update-plugins",
            ...(failure === "fresh-finalizer"
              ? { recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" } }
              : {}),
            ...(failure === "doctor"
              ? {
                  postUpdate: {
                    ...result.postUpdate,
                    plugins: {
                      ...successfulPluginUpdate,
                      status: "error",
                      reason: POST_PLUGIN_DOCTOR_EXECUTION_FAILED_REASON,
                      failureFacts: facts,
                    },
                  },
                }
              : {}),
            steps: [
              ...result.steps,
              ...(failure === "lint"
                ? [
                    {
                      name: "post-plugin doctor",
                      command: "openclaw doctor",
                      cwd: root,
                      durationMs: 0,
                      exitCode: 0,
                    },
                  ]
                : []),
              {
                name: "post-update verification",
                command:
                  failure === "fresh-finalizer" ? "openclaw update" : "openclaw plugins update",
                cwd: root,
                durationMs: 0,
                exitCode: 1,
                failureFacts: facts,
              },
            ],
          },
        };
      });
    }
    const start = vi
      .spyOn(serviceCommand, "runUpdatedInstallGatewayCommand")
      .mockImplementation(async (command) => {
        command.onGatewayStartAttempted?.();
        if (platform === "win32") {
          const launched = await mocks.task(["/Run", "/TN", "fixture-gateway"]);
          if (launched.code !== 0) {
            throw new Error("Scheduled Task remained disabled after Doctor failure");
          }
        } else {
          running = true;
        }
        return "accepted";
      });
    const health = async () => ({
      healthy: running,
      outcome: running ? ("ready" as const) : ("failed" as const),
      runtime: state().runtime,
      gatewayVersion: "2026.9.5",
      portUsage: {
        port: 19431,
        status: running ? ("busy" as const) : ("free" as const),
        listeners: [],
        hints: [],
      },
      staleGatewayPids: [],
      waitOutcome: running ? ("healthy" as const) : ("stopped-free" as const),
    });
    vi.spyOn(restartHealth, "waitForGatewayHealthyRestart").mockImplementation(health);
    vi.spyOn(restartHealth, "inspectGatewayRestart").mockImplementation(health);
    vi.spyOn(restartHealth, "waitForGatewayHttpReadiness").mockImplementation(async () => ({
      healthz: running ? 200 : 503,
      readyz: running ? 200 : 503,
    }));
    const actual = await vi.importActual<typeof import("./update-command-verification.js")>(
      "./update-command-verification.js",
    );
    vi.mocked(verifyUpdatedGateway).mockImplementation(actual.verifyUpdatedGateway);
    mocks.activePort.mockResolvedValue(19431);
    if (fence === "recorded-risk") {
      updateLedger.recordUpdateRunVerification(
        run.runId,
        {
          recovery: {
            serviceRestartSafe: false,
            reason: "runtime-verification-failed",
            dataAtRisk: "unreadable-state",
          },
        },
        { env: run.env },
      );
    }
    if (fence === "no-restart") {
      params.opts.restart = false;
    }
    if (fence === "mutation") {
      params.mutationStarted = true;
    }
    if (fence === "mutation-disallowed") {
      params.preManagedServiceStop!.serviceMutationAllowed = false;
    }
    const ledgerRead =
      fence === "ledger-unreadable"
        ? vi.spyOn(updateLedger, "getUpdateRun").mockImplementation(() => {
            throw new Error("ledger read refused");
          })
        : undefined;
    let caught: unknown;
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(root);
      servicePlatform.mockReturnValue(platform);
      try {
        params.preManagedServiceStop!.serviceUpdateVerdict =
          await serviceMaintenance.revalidateManagedGatewayServiceAfterUpdate({
            state: state(),
            root,
          });
        if (fence === "foreign") {
          params.preManagedServiceStop!.serviceUpdateVerdict = {
            kind: "foreign",
            reason: "fixture foreign",
          } as never;
        }
        await expect(
          finishUpdate(params).catch((error: unknown) => {
            caught = error;
            throw error;
          }),
        ).rejects.toMatchObject({
          result: {
            status: "error",
            ...(fence
              ? {}
              : {
                  recovery: dataAtRisk
                    ? { serviceRestartSafe: false }
                    : { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
                }),
          },
        });
      } finally {
        servicePlatform.mockReturnValue(hostPlatform);
      }
    });
    ledgerRead?.mockRestore();
    if (fence === "late-risk-unknown" || fence === "late-risk-custody") {
      const messages = (error: unknown): string[] =>
        error instanceof AggregateError
          ? [error.message, ...error.errors.flatMap(messages)]
          : error instanceof Error
            ? [error.message, ...messages(error.cause)]
            : [];
      expect(messages(caught).join("\n")).toContain(
        fence === "late-risk-custody"
          ? "fixture-native-custody-lost"
          : "fixture-unknown-restoration-error",
      );
    }
    if (fence === "late-risk-service-read" || fence === "late-risk-port") {
      expect(lateRiskPublished).toBe(true);
    }
    const deniedBeforePark = fence === "mutation-disallowed" || fence === "foreign";
    expect(stop).toHaveBeenCalledTimes(deniedBeforePark ? 0 : 1);
    expect(start).toHaveBeenCalledTimes(dataAtRisk || fence ? 0 : 1);
    expect(running).toBe(deniedBeforePark || (!dataAtRisk && !fence));
    if (platform === "win32") {
      expect(enabled).toBe(!dataAtRisk);
    } else {
      expect(mocks.task).not.toHaveBeenCalled();
    }
    const recorded = updateLedger.getUpdateRun(run.runId, { env: run.env });
    const recordedFacts = recorded?.steps.find(
      (step) => step.step === "post-update verification",
    )?.failureFacts;
    assert(recorded);
    const report = renderUpdateRunReport(recorded).markdown;
    // Even when parking is forbidden, convergence failure facts remain reportable.
    expect(recordedFacts).toEqual(expect.arrayContaining(facts));
    for (const fact of facts) {
      expect(report).toContain(fact.check);
    }
  },
);

it.each(["typed", "deferred", "untyped", "publication"] as const)(
  "preserves restoration evidence and publication ownership: %s",
  async (mode) => {
    const { publishRestorationFailure } =
      await import("./update-command-current-core-restoration.js");
    const { UpdateCommandFailure } = await import("./update-command-result.js");
    const result = { status: "error" as const, mode: "git" as const, steps: [], durationMs: 0 };
    const original =
      mode === "untyped" ? new Error("native failure") : new UpdateCommandFailure(result);
    const publicationError = new Error("diagnostic admission failed");
    const publish = vi.fn(async () => {
      if (mode === "publication") {
        throw publicationError;
      }
      return result;
    });
    if (mode === "publication") {
      try {
        await publishRestorationFailure(original, false, publish);
        assert.fail("expected preserved publication failure");
      } catch (error) {
        assert(error instanceof AggregateError);
        expect(error.errors).toEqual([original, publicationError]);
        expect(error.cause).toBe(publicationError);
      }
    } else {
      await expect(publishRestorationFailure(original, mode === "deferred", publish)).rejects.toBe(
        original,
      );
    }
    expect(publish).toHaveBeenCalledTimes(mode === "deferred" || mode === "untyped" ? 0 : 1);
  },
);
