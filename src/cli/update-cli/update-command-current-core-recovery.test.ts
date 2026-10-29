import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  withGatewayServiceUpdateAuthority,
  assertGatewayServiceUpdateCurrent,
  getGatewayServiceUpdateNativeCommand,
} from "../../daemon/service-update-authority.js";
import { createUpdateRun, recordUpdateRunVerification } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  isCurrentCoreFailureRecoveryEligible,
  isUntouchedFailureRecovery,
  assertCurrentCoreRecoveryRisk,
} from "./update-command-current-core-recovery.js";
import { captureRestorationRisk } from "./update-command-current-core-recovery.test-support.js";
import { createPostUpdateRepairFixture } from "./update-command-post-update-repair.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.each([
  "positive",
  "not-current",
  "mutation",
  "package",
  "database-backup",
  "rollback-blocked",
  "rollback-attempted",
  "original-rebind",
  "definition-backup",
  "definition-unverified",
  "prior-install",
  "prior-restart",
  "no-restart",
  "restart-option",
  "not-stopped",
  "mutation-disallowed",
  "foreign",
] as const)("independent current-core eligibility fence: %s", (scenario) => {
  const params = createPostUpdateRepairFixture(dirs.make("current-core-fence-"));
  params.coreAlreadyCurrent = true;
  params.mutationStarted = false;
  params.rollbackBlockedReason = undefined;
  const state = {
    rollbackAttempted: false,
    definitionRecovery: {},
    gatewayStartAttempted: undefined,
    serviceStop: params.preManagedServiceStop,
  };
  if (scenario === "not-current") {
    params.coreAlreadyCurrent = false;
  }
  if (scenario === "mutation") {
    params.mutationStarted = true;
  }
  if (scenario === "package") {
    Reflect.set(params, "packageTransaction", {});
  }
  if (scenario === "database-backup") {
    Reflect.set(params, "databaseBackup", {});
  }
  if (scenario === "rollback-blocked") {
    params.rollbackBlockedReason = "rollback-state-unverified";
  }
  if (scenario === "rollback-attempted") {
    state.rollbackAttempted = true;
  }
  if (scenario === "original-rebind") {
    Reflect.set(params, "originalManagedServiceRuntime", { definition: { rebound: "changed" } });
  }
  if (scenario === "definition-backup") {
    Reflect.set(state.definitionRecovery, "backup", {});
  }
  if (scenario === "definition-unverified") {
    Reflect.set(state.definitionRecovery, "unverified", true);
  }
  if (scenario === "prior-install") {
    Reflect.set(state, "gatewayStartAttempted", "install");
  }
  if (scenario === "prior-restart") {
    Reflect.set(state, "gatewayStartAttempted", "restart");
  }
  if (scenario === "no-restart") {
    params.shouldRestart = false;
  }
  if (scenario === "restart-option") {
    params.opts.restart = false;
  }
  if (scenario === "not-stopped") {
    state.serviceStop!.stopped = false;
  }
  if (scenario === "mutation-disallowed") {
    state.serviceStop!.serviceMutationAllowed = false;
  }
  if (scenario === "foreign") {
    Reflect.set(state.serviceStop!, "serviceUpdateVerdict", { kind: "foreign" });
  }
  expect(isCurrentCoreFailureRecoveryEligible(params, state)).toBe(scenario === "positive");
});

it.each([false, true, undefined, null, 0, ""])(
  "requires explicit no-mutation evidence for recovery: %s",
  (mutationStarted) => {
    const params = createPostUpdateRepairFixture(dirs.make("current-core-mutation-"));
    params.coreAlreadyCurrent = true;
    params.rollbackBlockedReason = undefined;
    Reflect.set(params, "mutationStarted", mutationStarted);
    const state = {
      rollbackAttempted: false,
      definitionRecovery: {},
      gatewayStartAttempted: undefined,
      serviceStop: params.preManagedServiceStop,
    };
    expect(isCurrentCoreFailureRecoveryEligible(params, state)).toBe(mutationStarted === false);
    params.preManagedServiceStop = undefined;
    expect(isUntouchedFailureRecovery(params, undefined, state)).toBe(mutationStarted === false);
  },
);

it.each([
  "healthy",
  "risk-before",
  "risk-after-await",
  "queued-native",
  "missing",
  "replacement",
] as const)("live risk restriction at native authority: %s", async (scenario) => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("live-risk-") };
  const run = createUpdateRun({ trigger: "cli" }, { env });
  const restriction = await captureRestorationRisk({ ...run, env });
  const risk = () =>
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
  let effects = 0;
  if (scenario === "risk-before") {
    risk();
  }
  if (scenario === "missing") {
    Reflect.set(restriction, "runId", "absent");
  }
  if (scenario === "replacement") {
    closeOpenClawStateDatabaseForTest();
    fs.renameSync(restriction.path, restriction.path + ".old");
    fs.writeFileSync(restriction.path, "replacement");
  }
  const attempt = withGatewayServiceUpdateAuthority(
    () => assertCurrentCoreRecoveryRisk(restriction),
    async () => {
      await Promise.resolve();
      if (scenario === "risk-after-await") {
        risk();
      }
      if (scenario === "queued-native") {
        const native = getGatewayServiceUpdateNativeCommand()!;
        const pending = native(["fixture"], {});
        risk();
        await pending;
      } else {
        assertGatewayServiceUpdateCurrent();
        effects++;
      }
    },
    {
      nativeCommand: async () => {
        effects++;
        return {
          code: 0,
          stdout: "",
          stderr: "",
          termination: "exit",
          signal: null,
          killed: false,
          cleanup: "normal",
        };
      },
    },
  );
  if (scenario === "healthy") {
    await expect(attempt).resolves.toBeUndefined();
  } else {
    await expect(attempt).rejects.toThrow();
  }
  expect(effects).toBe(scenario === "healthy" ? 1 : 0);
});
