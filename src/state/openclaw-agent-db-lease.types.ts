import type { SqliteIntegrityCheck } from "../infra/sqlite-integrity.js";
import type { OpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import type { OpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";

export type OpenClawAgentDatabaseWorkerLeaseReceipt = {
  leaseId: string;
  agentId: string;
  path: string;
  ownerPid: number;
  ownerStartTime: number | null;
  sharedStatePath: string;
  sharedStateIdentity: string;
};

export type OpenClawAgentIntegrityVerificationReceiver = (
  record: OpenClawAgentIntegrityVerification | undefined,
  canReuseRuntimeIntegrity: boolean,
  invalidated: boolean,
  because?: string,
) => void;

/** Prepared state-owner facts remain a claim, never an admission grant. */
export type PreparedOpenClawAgentDatabaseWorkerLease = {
  receipt: OpenClawAgentDatabaseWorkerLeaseReceipt;
  provenance: string | null;
  validation?: OpenClawAgentDatabaseValidation;
  deferUnverifiedIntegrity?: boolean;
  startupRepair?: (
    check: SqliteIntegrityCheck,
    error: unknown,
    assertCurrent: () => void,
  ) => boolean;
  claim(onVerification?: OpenClawAgentIntegrityVerificationReceiver): string;
};
