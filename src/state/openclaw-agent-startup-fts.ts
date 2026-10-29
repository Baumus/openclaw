import { repairDoctorSqliteIndexCorruption } from "../infra/sqlite-index-recovery.js";
import {
  classifySqliteFtsIntegrityFindings,
  readSqliteIntegrityFindings,
  type SqliteIntegrityCheck,
} from "../infra/sqlite-integrity.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { readAgentDeletionJournalStatusInDatabase } from "./agent-deletion-journal.read.js";
import { mayShareAgentDatabaseFile } from "./openclaw-agent-db-lease-provenance.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "./openclaw-agent-db-lease.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.types.js";
import { AGENT_FTS_SCHEMAS } from "./openclaw-agent-fts-schema.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";

/** The native worker repairs only owned FTS under its existing shared write fence. */
export function repairAgentDatabaseStartupFts(context: {
  receipt: OpenClawAgentDatabaseWorkerLeaseReceipt;
  check: SqliteIntegrityCheck;
  error: unknown;
  assertCurrent: () => void;
  assertFileIdentity: () => void;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const { receipt, check, error } = context;
  if (
    !(error instanceof Error) ||
    error.name !== "SqliteIntegrityError" ||
    error.cause ||
    check.databaseLabel !== receipt.path ||
    !classifySqliteFtsIntegrityFindings(
      check.database,
      readSqliteIntegrityFindings(check.database),
      AGENT_FTS_SCHEMAS,
    )
  ) {
    return false;
  }
  return runOpenClawStateWriteTransaction(
    (shared) => {
      const admit = (phase: "begin" | "check" | "complete", message?: string) => {
        context.assertCurrent();
        context.assertFileIdentity();
        requestSqliteWorkerOperationAdmission({
          stage: "prepare",
          facts: {
            kind: "agent-startup-fts",
            phase,
            lease: receipt,
            message,
            agentDeletionJournalPresent:
              readAgentDeletionJournalStatusInDatabase(shared.db, receipt.agentId) !== "absent",
          },
        });
      };
      context.assertCurrent();
      context.assertFileIdentity();
      const owners = readActiveOpenClawAgentDatabaseLeasesReadOnly({
        env: context.env,
        path: receipt.sharedStatePath,
      }).filter((owner) => mayShareAgentDatabaseFile(owner.path, receipt.path));
      if (owners.length !== 1 || owners[0]?.lease_id !== receipt.leaseId) {
        throw new Error("Startup FTS repair requires an exclusive live agent database lease");
      }
      admit("begin");
      const changes = repairDoctorSqliteIndexCorruption(check.database, check.databaseLabel, {
        label: "agent " + receipt.agentId,
        ftsSchemas: AGENT_FTS_SCHEMAS,
        ftsOnly: true,
        assertCurrent: () => admit("check"),
        describeRepair: (indexes) =>
          "Rebuilt stale SQLite FTS indexes (agent " +
          receipt.agentId +
          "): " +
          indexes.join(", ") +
          ". No table rows were removed.",
      });
      admit("complete", changes.join(" "));
      return true;
    },
    { env: context.env, path: receipt.sharedStatePath },
  );
}
