import { z } from "zod";
import {
  assertDatabasePathIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import type { UpdateServiceDefinitionRecovery } from "./update-command-service-context-types.js";
import type { PreManagedServiceStop } from "./update-command-service-maintenance.js";

// A restriction, never an alternative executor grant. Native effects still
// require the original live child lease as well as this live risk restriction.
export const currentCoreRecoveryRiskSchema = z.strictObject({
  runId: z.string().min(1),
  path: z.string().min(1),
  identity: z.strictObject({
    key: z.string().regex(/^file:(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/),
    canonicalPath: z.string().min(1),
    birthtime: z.string().optional(),
  }),
});
export type CurrentCoreRecoveryRisk = z.infer<typeof currentCoreRecoveryRiskSchema>;
function captureCurrentCoreRecoveryRisk(
  run: NonNullable<UpdateCommandOptions["run"]>,
): CurrentCoreRecoveryRisk {
  const path = resolveOpenClawStateSqlitePath(run.env);
  const restriction = currentCoreRecoveryRiskSchema.parse({
    runId: run.runId,
    path,
    identity: readDatabasePathIdentitySync(path),
  });
  assertCurrentCoreRecoveryRisk(restriction);
  return restriction;
}
export function assertCurrentCoreRecoveryRisk(restriction: CurrentCoreRecoveryRisk): void {
  assertDatabasePathIdentity(restriction.path, restriction.identity);
  const record = getUpdateRun(restriction.runId, { path: restriction.path });
  assertDatabasePathIdentity(restriction.path, restriction.identity);
  if (
    !record ||
    (record.verification.recovery?.serviceRestartSafe === false &&
      record.verification.recovery.dataAtRisk)
  ) {
    throw new Error("Current-core recovery has missing or unsafe recorded state.");
  }
}

export function isCurrentCoreFailureRecoveryEligible(
  params: FinishUpdateParams,
  state: {
    rollbackAttempted: boolean;
    definitionRecovery: UpdateServiceDefinitionRecovery;
    gatewayStartAttempted: "install" | "restart" | undefined;
    serviceStop: PreManagedServiceStop | undefined;
  },
): boolean {
  // Only an explicit false proves that no mutation started; unknown runtime input refuses.
  switch (params.mutationStarted) {
    case false:
      break;
    default:
      return false;
  }
  return (
    params.coreAlreadyCurrent === true &&
    !params.packageTransaction &&
    !params.databaseBackup &&
    !params.rollbackBlockedReason &&
    !state.rollbackAttempted &&
    !params.originalManagedServiceRuntime &&
    !state.definitionRecovery.backup &&
    !state.definitionRecovery.unverified &&
    !state.gatewayStartAttempted &&
    params.shouldRestart &&
    params.opts.restart !== false &&
    state.serviceStop?.stopped === true &&
    state.serviceStop.serviceMutationAllowed !== false &&
    state.serviceStop.serviceUpdateVerdict?.kind === "owned"
  );
}

// A failed read denies restoration. It must not revoke executor cleanup errors.
export function refreshCurrentCoreRecovery(
  result: UpdateRunResult,
  run: UpdateCommandOptions["run"],
  assertCurrent: () => void,
  failClosed = false,
): boolean {
  try {
    const recorded = run ? getUpdateRun(run.runId, { env: run.env }) : undefined;
    const risk = [result.recovery, recorded?.verification.recovery].find(
      (recovery) => recovery?.serviceRestartSafe === false && recovery.dataAtRisk,
    );
    if (recorded && !risk) {
      return true;
    }
    if (risk || failClosed) {
      result.recovery = risk ?? {
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      };
    }
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    assertCurrent();
    if (failClosed) {
      result.recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
    }
  }
  return false;
}

export async function withCurrentCoreRestoration<T>(params: {
  enabled: boolean;
  run: UpdateCommandOptions["run"];
  result: UpdateRunResult;
  restore: (risk?: CurrentCoreRecoveryRisk, assertSafe?: () => void) => Promise<T>;
  failure: (cause: unknown) => Error;
}): Promise<T> {
  try {
    const risk =
      params.enabled && params.run ? captureCurrentCoreRecoveryRisk(params.run) : undefined;
    return await params.restore(
      risk,
      risk
        ? () => {
            assertCurrentCoreRecoveryRisk(risk);
            if (
              params.result.recovery?.serviceRestartSafe === false &&
              params.result.recovery.dataAtRisk
            ) {
              throw new Error("Current-core recovery has unsafe current state.");
            }
          }
        : undefined,
    );
  } catch (error) {
    if (!params.enabled || hasCommandProcessCleanupError(error)) {
      throw error;
    }
    // Preserve the original failed steps and the restoration exception. A named
    // risk restricts recovery; it never replaces a custody/native failure.
    let cause = error;
    try {
      const recorded = params.run
        ? getUpdateRun(params.run.runId, { env: params.run.env })
        : undefined;
      const risk = [params.result.recovery, recorded?.verification.recovery].find(
        (recovery) => recovery?.serviceRestartSafe === false && recovery.dataAtRisk,
      );
      params.result.recovery = risk ?? {
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      };
    } catch (revalidationError) {
      params.result.recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
      cause = new AggregateError(
        [error, revalidationError],
        "Restoration and risk revalidation failed.",
        { cause: error },
      );
    }
    throw params.failure(cause);
  }
}

export function admitCurrentCoreFailureRecovery(
  params: FinishUpdateParams,
  result: UpdateRunResult,
  state: Parameters<typeof isCurrentCoreFailureRecoveryEligible>[1],
  assertCurrent: () => void,
): boolean {
  return (
    isCurrentCoreFailureRecoveryEligible(params, state) &&
    refreshCurrentCoreRecovery(result, params.opts.run, assertCurrent)
  );
}

// Unknown mutation history still requires the original independent observation.
export function isUntouchedFailureRecovery(
  params: FinishUpdateParams,
  serviceStop: PreManagedServiceStop | undefined,
  state: Pick<
    Parameters<typeof isCurrentCoreFailureRecoveryEligible>[1],
    "gatewayStartAttempted" | "definitionRecovery" | "rollbackAttempted"
  >,
): boolean {
  // Unknown mutation history must retain recovery probing.
  switch (params.mutationStarted) {
    case false:
      break;
    default:
      return false;
  }
  return (
    !params.rollbackBlockedReason &&
    !params.preManagedServiceStop?.stopped &&
    !serviceStop?.stopped &&
    !state.gatewayStartAttempted &&
    !state.definitionRecovery.backup &&
    !state.definitionRecovery.unverified &&
    !state.rollbackAttempted &&
    !params.originalManagedServiceRuntime?.definition.rebound
  );
}
