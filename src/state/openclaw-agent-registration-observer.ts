import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerAdmissionRequest } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.types.js";
import type { AgentDatabaseRegistration } from "./openclaw-agent-db-registry-listing.js";

/** Observe a witnessed registration commit without reopening revoked admission. */
export function createAgentRegistrationCommitObserver(context: {
  agentId: string;
  pathname: string;
  getRegistration: () => AgentDatabaseRegistration | undefined;
  getLease: () => OpenClawAgentDatabaseWorkerLeaseReceipt | undefined;
}) {
  return (request: SqliteWorkerAdmissionRequest): void => {
    const registration = context.getRegistration();
    const lease = context.getLease();
    const facts = request.facts;
    if (
      request.stage === "prepare" &&
      isRecord(facts) &&
      facts.kind === "agent-registration-committed"
    ) {
      const received = facts.registration;
      if (
        !registration ||
        !lease ||
        !isRecord(received) ||
        received.agentId !== context.agentId ||
        received.agentPath !== context.pathname ||
        received.stateDatabasePath !== lease.sharedStatePath ||
        received.stateDatabaseIdentity !== lease.sharedStateIdentity
      ) {
        throw new Error("Agent registration commit differs from its admitted native owner");
      }
      // Revocation governs future work; it cannot erase a witnessed COMMIT.
      registration.recordCommitted({
        agentId: context.agentId,
        agentPath: context.pathname,
        stateDatabasePath: lease.sharedStatePath,
        stateDatabaseIdentity: lease.sharedStateIdentity,
      });
    }
  };
}
