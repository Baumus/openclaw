import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.types.js";
import type { AgentDatabaseExecutionFileIdentity } from "./openclaw-agent-execution-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

// Host-owned attempts outlive native workers, but never authorize a different physical file.
const attempts = new Map<string, { statePath: string; message?: string }>();

export function listAgentDatabaseStartupFtsRepairs(): string[] {
  const statePath = resolveOpenClawStateSqlitePath(process.env);
  return [...attempts.values()].flatMap((entry) =>
    entry.statePath === statePath && entry.message ? [entry.message] : [],
  );
}

/** Validate every repair checkpoint against the live source, journal, lease and file. */
export function createAgentDatabaseStartupFtsAdmission(context: {
  pathname: string;
  sharedStatePath: string;
  expectedIdentity?: AgentDatabaseExecutionFileIdentity;
  assertCurrent: () => void;
  assertPreparationJournal?: (present: unknown) => void;
  getLease: () => OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
}) {
  let attemptedKey: string | undefined;
  return (facts: unknown): boolean => {
    if (!isRecord(facts) || facts.kind !== "agent-startup-fts") {
      return false;
    }
    context.assertCurrent();
    const lease = context.getLease();
    if (
      !context.assertPreparationJournal ||
      !lease ||
      !isDeepStrictEqual(facts.lease, lease) ||
      (facts.phase !== "begin" && facts.phase !== "check" && facts.phase !== "complete") ||
      (facts.phase === "complete" && (typeof facts.message !== "string" || !facts.message))
    ) {
      throw new Error("FTS repair requires live Gateway startup admission and its exact lease");
    }
    context.assertPreparationJournal(facts.agentDeletionJournalPresent);
    const identity = readDatabasePathIdentitySync(context.pathname);
    if (!identity.key.startsWith("file:")) {
      throw new Error("Startup FTS repair requires an existing physical file");
    }
    const expected = context.expectedIdentity;
    if (expected) {
      assertExistingDatabaseIdentity(
        context.pathname,
        "file:" + expected.physicalIdentity,
        expected.birthtime,
      );
    }
    const key = JSON.stringify([identity.key, identity.birthtime]);
    if (facts.phase === "begin") {
      if (attempts.has(key)) {
        throw new Error("Startup FTS repair was already attempted. Run openclaw doctor --fix.");
      }
      // Latch before the worker receives permission to back up or rebuild.
      attempts.set(key, { statePath: context.sharedStatePath });
      attemptedKey = key;
    } else if (!attemptedKey || attemptedKey !== key || !attempts.has(key)) {
      throw new Error("Startup FTS repair lost its physical-generation attempt");
    } else if (facts.phase === "complete") {
      const entry = attempts.get(key)!;
      if (entry.message) {
        throw new Error("Startup FTS repair completion was already published");
      }
      // SAFETY: the complete-phase guard above requires a nonempty string message.
      entry.message = facts.message as string;
      createSubsystemLogger("state/agent-db").warn(entry.message);
    }
    return true;
  };
}
