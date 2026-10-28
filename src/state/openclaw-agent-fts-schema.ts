import { getMemoryFtsSchemaSqlVariants } from "../../packages/memory-host-sdk/src/host/memory-schema-fts.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

/** Static agent DDL and the memory owner's lazily installed FTS definitions. */
export const AGENT_FTS_SCHEMAS = [OPENCLAW_AGENT_SCHEMA_SQL, ...getMemoryFtsSchemaSqlVariants()];
