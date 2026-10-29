import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  createAgentDatabaseStartupFtsAdmission,
  listAgentDatabaseStartupFtsRepairs,
} from "./agent-database-startup-fts.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

// The process-wide attempt latch retains physical identities. Keep fixture files alive
// across tests so Linux cannot recycle an earlier fixture's inode into a new one.
const roots = useAutoCleanupTempDirTracker(afterAll);
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const root = roots.make("startup-fts-authority-");
  const pathname = path.join(root, "agent.sqlite");
  fs.writeFileSync(pathname, "physical-file");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const sharedStatePath = resolveOpenClawStateSqlitePath(process.env);
  const lease = {
    leaseId: "exact-lease",
    agentId: "main",
    path: pathname,
    ownerPid: process.pid,
    ownerStartTime: null,
    sharedStatePath,
    sharedStateIdentity: "file:1:2",
  };
  let live = true;
  const context = {
    pathname,
    sharedStatePath,
    assertCurrent: () => {
      if (!live) {
        throw new Error("stale source");
      }
    },
    assertPreparationJournal: (present: unknown) => {
      if (!live || present !== false) {
        throw new Error("stale journal");
      }
    },
    getLease: () => lease,
  };
  const facts = (phase: "begin" | "check" | "complete", message?: string) => ({
    kind: "agent-startup-fts",
    phase,
    lease,
    agentDeletionJournalPresent: false,
    message,
  });
  return {
    pathname,
    context,
    facts,
    lease,
    expire: () => {
      live = false;
    },
  };
}

it("latches an attempt before completion across native owner replacement", () => {
  const f = fixture();
  const admit = createAgentDatabaseStartupFtsAdmission(f.context);
  expect(admit(f.facts("begin"))).toBe(true);
  expect(admit(f.facts("check"))).toBe(true);
  // No completion simulates failed backup/rebuild or native worker loss.
  expect(() => createAgentDatabaseStartupFtsAdmission(f.context)(f.facts("begin"))).toThrow(
    /already attempted/,
  );
  expect(listAgentDatabaseStartupFtsRepairs()).toEqual([]);
});

it("requires live journal and exact lease, including after the attempt begins", () => {
  const f = fixture();
  const admit = createAgentDatabaseStartupFtsAdmission(f.context);
  expect(() => admit({ ...f.facts("begin"), lease: { ...f.lease, leaseId: "foreign" } })).toThrow(
    /exact lease/,
  );
  expect(() => admit({ ...f.facts("begin"), agentDeletionJournalPresent: true })).toThrow(
    /stale journal/,
  );
  expect(admit(f.facts("begin"))).toBe(true);
  f.expire();
  expect(() => admit(f.facts("check"))).toThrow(/stale source/);
  expect(() => admit(f.facts("complete", "must not publish"))).toThrow(/stale source/);
  expect(listAgentDatabaseStartupFtsRepairs()).toEqual([]);
});

it("requires the startup grant and a begin before completion", () => {
  const f = fixture();
  expect(() =>
    createAgentDatabaseStartupFtsAdmission({ ...f.context, assertPreparationJournal: undefined })(
      f.facts("begin"),
    ),
  ).toThrow(/live Gateway startup/);
  expect(() =>
    createAgentDatabaseStartupFtsAdmission(f.context)(f.facts("complete", "false repair")),
  ).toThrow(/lost its physical-generation attempt/);
  expect(createAgentDatabaseStartupFtsAdmission(f.context)({ kind: "agent-open-resume" })).toBe(
    false,
  );
});

it("publishes a successful repair once and admits a new physical generation only", () => {
  const f = fixture();
  const before = readDatabasePathIdentitySync(f.pathname);
  const expectedIdentity = {
    kind: "file" as const,
    physicalIdentity: before.key.slice(5),
    birthtime: before.birthtime,
    nativeLocation: f.pathname,
  };
  const admit = createAgentDatabaseStartupFtsAdmission({ ...f.context, expectedIdentity });
  admit(f.facts("begin"));
  admit(f.facts("complete", "successful FTS repair"));
  expect(listAgentDatabaseStartupFtsRepairs()).toEqual(["successful FTS repair"]);
  expect(() => admit(f.facts("complete", "duplicate"))).toThrow(/already published/);
  fs.copyFileSync(f.pathname, f.pathname + ".next");
  fs.renameSync(f.pathname + ".next", f.pathname);
  expect(readDatabasePathIdentitySync(f.pathname).key).not.toBe(before.key);
  expect(() => admit(f.facts("check"))).toThrow();
  expect(createAgentDatabaseStartupFtsAdmission(f.context)(f.facts("begin"))).toBe(true);
});
