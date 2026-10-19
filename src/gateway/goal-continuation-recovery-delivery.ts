import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import {
  assertSessionWriterDeliveryAuthorized,
  prepareSessionWriterDeliveryAuthority,
} from "../auto-reply/reply/session-writer-delivery-authority.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { createChatSendLateFollowupDisposition } from "./server-methods/chat-send-late-followup.js";
import { createChatSendLateReplyFinalizer } from "./server-methods/chat-send-source-finalization.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Rebuild delivery under current subscriptions, never retain a pre-restart RPC callback. */
export function createRecoveredGoalReplyDisposition(params: {
  context: GatewayRequestContext;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  agentId: string;
  runId: string;
  storePath?: string;
  operatorAuthority: AdmittedRunOperatorAuthority;
  signal?: AbortSignal;
}): FollowupRun["queuedFollowupReplyDisposition"] {
  const disposition = createChatSendLateFollowupDisposition({
    runId: params.runId,
    retainSourceIdentity: false,
    originatingChannel: INTERNAL_MESSAGE_CHANNEL,
    logGateway: params.context.logGateway,
    deliver: async (batch) => {
      const source = await prepareSessionWriterDeliveryAuthority({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        expectedSessionId: params.sessionId,
        expectedLifecycleRevision: params.lifecycleRevision,
      });
      const isCurrent = () => {
        params.signal?.throwIfAborted();
        params.operatorAuthority.assertCurrent();
        assertSessionWriterDeliveryAuthorized(source.authority);
        return batch.isCurrent();
      };
      try {
        isCurrent();
        const finalize = createChatSendLateReplyFinalizer({
          context: params.context,
          terminalEntry: undefined,
          accountId: undefined,
          abortSignal: params.signal,
          session: {
            cfg: params.context.getRuntimeConfig(),
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            backingSessionId: params.sessionId,
            clientRunId: batch.clientRunId,
            sessionLoadOptions: { agentId: params.agentId },
            storePath: params.storePath,
          },
        });
        return await finalize({ ...batch, isCurrent });
      } finally {
        source.release();
      }
    },
  });
  disposition.recordQueued();
  return { kind: "deliver", deliver: disposition.deliver };
}
