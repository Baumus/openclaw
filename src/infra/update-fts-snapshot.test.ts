import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AGENT_FTS_SCHEMAS } from "../state/openclaw-agent-fts-schema.js";
import { installSqliteFtsTokenizerMismatch } from "./sqlite-index-corruption.test-support.js";
import {
  discoverUpdateStateSchemaInspectionInProcess,
  readUpdateCandidateStateInventoryInProcess,
  snapshotUpdateCandidateState,
} from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
it.each(["candidate", "backup"] as const)(
  "preserves stale owned FTS through real %s inventory and copy",
  async (mode) => {
    const root = await fs.realpath(dirs.make("update-fts-inventory-"));
    const stateDir = path.join(root, "state");
    const targetStateDir = path.join(root, "rehearsal");
    const relative = path.join("agents", "main", "agent", "openclaw-agent.sqlite");
    const sourcePath = path.join(stateDir, relative);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(targetStateDir);
    {
      using db = new DatabaseSync(sourcePath);
      const ddl = AGENT_FTS_SCHEMAS.join("\n").match(
        /CREATE VIRTUAL TABLE IF NOT EXISTS session_transcript_fts[^;]+;/u,
      )?.[0];
      if (!ddl) {
        throw new Error("Missing canonical session FTS DDL");
      }
      db.exec(ddl);
      db.exec(
        "PRAGMA user_version=3; CREATE TABLE evidence(value TEXT); INSERT INTO evidence(rowid,value) VALUES(71,'preserved'); INSERT INTO session_transcript_fts(text) VALUES ('ab'||char(65534)||'cd');",
      );
    }
    installSqliteFtsTokenizerMismatch(sourcePath, "session_transcript_fts");
    const original = await fs.readFile(sourcePath);
    const env = {
      ...process.env,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_WORKSPACE_DIR: path.join(root, "workspace"),
    };
    let copied: string;
    if (mode === "candidate") {
      const input = {
        stateDir,
        targetStateDir,
        candidateRoot: fileURLToPath(new URL("../../", import.meta.url)),
        config: {},
        env,
      };
      const inventory = await readUpdateCandidateStateInventoryInProcess(input);
      await snapshotUpdateCandidateState({
        ...input,
        pluginPlanPath: path.join(targetStateDir, inventory.pluginPlan),
        databaseInventory: [...inventory.databases.keys()],
      });
      copied = path.join(targetStateDir, relative);
    } else {
      const stagingRoot = path.join(root, "scratch");
      await fs.mkdir(stagingRoot);
      const input = {
        backupRoot: path.join(root, "retained"),
        stateDir,
        config: {},
        env,
        stagingRoot,
      };
      const inspectionPlan = await discoverUpdateStateSchemaInspectionInProcess(input);
      await fs.mkdir(input.backupRoot + ".databases", { recursive: true });
      const backup = await createUpdateDatabaseBackupInProcess({ ...input, inspectionPlan });
      copied =
        backup.databases.find((database) => database.path === sourcePath)?.snapshotPath ?? "";
      expect(copied).not.toBe("");
    }
    using snapshot = new DatabaseSync(copied, { readOnly: true });
    expect(snapshot.prepare("SELECT rowid,value FROM evidence").all()).toEqual([
      { rowid: 71, value: "preserved" },
    ]);
    expect(snapshot.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "malformed inverted index for FTS5 table main.session_transcript_fts" },
    ]);
    expect(await fs.readFile(sourcePath)).toEqual(original);
  },
);
