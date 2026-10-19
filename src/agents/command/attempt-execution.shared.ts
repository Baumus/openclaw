import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  reduceSessionBookkeeping,
  type SessionEntryBookkeepingReducer,
} from "../../config/sessions/session-entry-patch-operation.js";
import { buildSessionCreationStamp } from "../../config/sessions/session-entry-provenance.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import {
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
type PersistSessionEntryParams = {
  agentId: string;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  initialEntry: SessionEntry;
  entry: SessionEntry;
  reducers?: SessionEntryBookkeepingReducer[];
  creation?: Parameters<typeof buildSessionCreationStamp>[0];
  assertCommitAllowed?: SessionSourceAssertion;
  shouldPersist?: (entry: SessionEntry | undefined) => boolean;
};

/** Persists one session entry while keeping the caller's in-memory store aligned. */
export async function persistAgentSession(
  params: PersistSessionEntryParams,
): Promise<SessionEntry | undefined> {
  let rejectedMissingEntry = false;
  let published = false;
  const persisted = await patchSessionEntryCore(
    { agentId: params.agentId, sessionKey: params.sessionKey, storePath: params.storePath },
    (_entry, context) => {
      const shouldPersistCurrent = params.shouldPersist?.(context.existingEntry);
      if (
        (!context.existingEntry && shouldPersistCurrent !== true) ||
        shouldPersistCurrent === false
      ) {
        rejectedMissingEntry = !context.existingEntry;
        return null;
      }
      if (!context.existingEntry) {
        return {
          ...params.entry,
          ...(params.creation ? buildSessionCreationStamp(params.creation) : {}),
        };
      }
      if (context.existingEntry.sessionId !== params.initialEntry.sessionId) {
        return null;
      }
      // Agent turns persist broad snapshots. Project only this turn's changes
      // so a stale snapshot cannot restore fields changed or cleared meanwhile.
      const next = mergeSessionSnapshotChanges({
        initial: params.initialEntry,
        next: params.entry,
        current: context.existingEntry,
      });
      for (const reducer of params.reducers ?? []) {
        Object.assign(next, reduceSessionBookkeeping(next, reducer));
      }
      return next;
    },
    {
      fallbackEntry: params.sessionStore[params.sessionKey] ?? params.entry,
      replaceEntry: true,
      ...sessionEntryCommitGuardOptions(params.assertCommitAllowed),
      requireWriteSuccess: params.creation !== undefined,
      onCommitted: (entry) => {
        published = true;
        params.sessionStore[params.sessionKey] = entry;
      },
    },
  );
  if (rejectedMissingEntry || !persisted) {
    delete params.sessionStore[params.sessionKey];
    return undefined;
  }
  if (!published) {
    params.sessionStore[params.sessionKey] = persisted;
  }
  return persisted;
}
