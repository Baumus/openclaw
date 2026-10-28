import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AGENT_FTS_SCHEMAS } from "../state/openclaw-agent-fts-schema.js";
import {
  corruptSqliteIndexKey,
  installSqliteFtsTokenizerMismatch,
} from "./sqlite-index-corruption.test-support.js";
import { repairDoctorSqliteIndexCorruption } from "./sqlite-index-recovery.js";
import { repairSqliteIndexCorruption } from "./sqlite-index-schema.js";
import { classifySqliteFtsIntegrityFindings } from "./sqlite-integrity.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const pathname = path.join(roots.make("fts-repair-"), "agent.sqlite");
  {
    using db = new DatabaseSync(pathname);
    // Extract every canonical virtual table, including the lazy memory variants.
    const schemas = AGENT_FTS_SCHEMAS.join("\n");
    for (const match of schemas.matchAll(/CREATE VIRTUAL TABLE[^;]+;/gu)) {
      if (!match[0].includes("content =")) {
        db.exec(match[0]);
      }
    }
    db.exec("INSERT INTO session_transcript_fts(text) VALUES ('ab'||char(65534)||'cd')");
    db.exec("INSERT INTO memory_index_chunks_fts(text) VALUES ('ab'||char(65534)||'cd')");
  }
  installSqliteFtsTokenizerMismatch(pathname, "session_transcript_fts");
  installSqliteFtsTokenizerMismatch(pathname, "memory_index_chunks_fts");
  return pathname;
}

it("backs up and rebuilds only canonical FTS indexes without changing content", () => {
  const pathname = fixture();
  using db = new DatabaseSync(pathname);
  const findings = db.prepare("PRAGMA integrity_check").all();
  expect(findings).toEqual([
    { integrity_check: "malformed inverted index for FTS5 table main.memory_index_chunks_fts" },
    { integrity_check: "malformed inverted index for FTS5 table main.session_transcript_fts" },
  ]);
  const rows = db.prepare("SELECT * FROM session_transcript_fts").all();
  expect(
    classifySqliteFtsIntegrityFindings(
      db,
      findings.map((row) => row.integrity_check),
      AGENT_FTS_SCHEMAS,
    ),
  ).toEqual(["memory_index_chunks_fts", "session_transcript_fts"]);
  const result = repairDoctorSqliteIndexCorruption(db, pathname, {
    label: "agent main",
    assertCurrent: () => {},
    ftsSchemas: AGENT_FTS_SCHEMAS,
  });
  const backupPath = expectDefined(result[0], "backup diagnostic").replace(
    "Saved pre-repair SQLite backup: ",
    "",
  );
  expect(fs.existsSync(backupPath)).toBe(true);
  using backup = new DatabaseSync(backupPath, { readOnly: true });
  expect(backup.prepare("PRAGMA integrity_check").all()).toEqual(findings);
  expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.prepare("SELECT * FROM session_transcript_fts").all()).toEqual(rows);
  expect(db.prepare("SELECT text FROM memory_index_chunks_fts").all()).toEqual([
    { text: "ab\ufffecd" },
  ]);
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM session_transcript_fts WHERE session_transcript_fts MATCH ?",
      )
      .get('"ab\ufffecd"'),
  ).toEqual({ n: 1 });
});

it.each(["unknown", "drifted", "mixed"])(
  "does not classify %s FTS findings as derived-only damage",
  (kind) => {
    const pathname = fixture();
    using db = new DatabaseSync(pathname);
    const findings = db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check);
    if (kind === "unknown") {
      findings.push("malformed inverted index for FTS5 table main.unowned");
    } else if (kind === "mixed") {
      findings.push("row 1 missing from index idx_data");
    } else {
      db.enableDefensive?.(false);
      db.exec("PRAGMA writable_schema=ON");
      db.prepare(
        "UPDATE sqlite_schema SET sql=replace(sql, 'text,', 'other,') WHERE name='session_transcript_fts'",
      ).run();
    }
    expect(classifySqliteFtsIntegrityFindings(db, findings, AGENT_FTS_SCHEMAS)).toBeUndefined();
  },
);

it("rolls an FTS rebuild back when commit authority is lost", () => {
  const pathname = fixture();
  using db = new DatabaseSync(pathname);
  const findings = db.prepare("PRAGMA integrity_check").all();
  const backup = vi.fn();
  expect(() =>
    repairSqliteIndexCorruption(db, pathname, {
      ftsSchemas: AGENT_FTS_SCHEMAS,
      backup,
      assertCurrent: () => {
        throw new Error("maintenance lost");
      },
    }),
  ).toThrow("maintenance lost");
  expect(backup).toHaveBeenCalledOnce();
  expect(db.prepare("PRAGMA integrity_check").all()).toEqual(findings);
});

it.each(["unowned", "mixed"] as const)(
  "refuses real %s corruption without backup or mutation",
  (kind) => {
    const pathname = fixture();
    {
      using seed = new DatabaseSync(pathname);
      if (kind === "unowned") {
        seed.exec(
          "CREATE VIRTUAL TABLE unowned USING fts5(text); INSERT INTO unowned VALUES ('ab'||char(65534)||'cd');",
        );
      } else {
        seed.exec(
          "CREATE TABLE retained(id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX idx_retained ON retained(value); INSERT INTO retained VALUES (1, 'unique-retained-key');",
        );
      }
    }
    if (kind === "unowned") {
      installSqliteFtsTokenizerMismatch(pathname, "unowned");
    } else {
      corruptSqliteIndexKey(pathname, "idx_retained", "unique-retained-key", "unique-corruptedkey");
    }
    using db = new DatabaseSync(pathname);
    const before = db.prepare("PRAGMA integrity_check(2147483647)").all();
    expect(before.length).toBeGreaterThan(2);
    const backup = vi.fn();
    expect(() =>
      repairSqliteIndexCorruption(db, pathname, {
        ftsSchemas: AGENT_FTS_SCHEMAS,
        backup,
        assertCurrent: () => {},
      }),
    ).toThrow(/Unrecognized SQLite integrity finding/);
    expect(backup).not.toHaveBeenCalled();
    expect(db.prepare("PRAGMA integrity_check(2147483647)").all()).toEqual(before);
  },
);

it.each(["owned", "unowned", "unopted", "mixed", "foreign-key"] as const)(
  "update snapshots copy %s stale FTS indexes only when they are owned and opted in",
  async (kind) => {
    const pathname = fixture();
    if (kind === "unowned") {
      {
        using db = new DatabaseSync(pathname);
        db.exec(`CREATE VIRTUAL TABLE unowned_fts USING fts5(text);
          INSERT INTO unowned_fts(text) VALUES ('ab'||char(65534)||'cd');`);
      }
      installSqliteFtsTokenizerMismatch(pathname, "unowned_fts");
    }
    if (kind === "mixed") {
      {
        using db = new DatabaseSync(pathname);
        db.exec(
          "CREATE TABLE retained(id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX idx_retained ON retained(value); INSERT INTO retained VALUES (1, 'unique-retained-key');",
        );
      }
      corruptSqliteIndexKey(pathname, "idx_retained", "unique-retained-key", "unique-corruptedkey");
    }
    if (kind === "foreign-key") {
      using db = new DatabaseSync(pathname);
      db.exec(
        "PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (7);",
      );
    }
    const original = fs.readFileSync(pathname);
    const targetPath = path.join(roots.make("fts-snapshot-"), "copy.sqlite");
    const snapshot = createVerifiedSqliteSnapshot({
      sourcePath: pathname,
      targetPath,
      preserveRowIds: true,
      ...(kind === "unopted" ? {} : { ftsSchemas: AGENT_FTS_SCHEMAS }),
    });
    if (kind !== "owned") {
      await expect(snapshot).rejects.toThrow(
        kind === "foreign-key" ? /foreign.key/u : /malformed inverted index/u,
      );
      expect(fs.existsSync(targetPath)).toBe(false);
      return;
    }
    await snapshot;
    using copy = new DatabaseSync(targetPath, { readOnly: true });
    // The runtime that admits the copy owns the rebuild; the copy keeps the old index bytes.
    expect(copy.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "malformed inverted index for FTS5 table main.memory_index_chunks_fts" },
      { integrity_check: "malformed inverted index for FTS5 table main.session_transcript_fts" },
    ]);
    expect(copy.prepare("SELECT text FROM session_transcript_fts").all()).toEqual([
      { text: "ab\ufffecd" },
    ]);
    expect(fs.readFileSync(pathname)).toEqual(original);
  },
);
