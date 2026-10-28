import * as memoryHost from "openclaw/plugin-sdk/memory-host-core";
import * as securityRuntime from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as boundedWalk from "./bounded-walk.js";
import { compileMemoryWikiVault } from "./compile.js";
import {
  activateMemoryWikiCompiledCacheOwner,
  deactivateMemoryWikiCompiledCacheOwnersExcept,
  loadMemoryWikiCompiledCache,
  setMemoryWikiDashboardState,
} from "./compiled-cache.js";
import * as compiledCache from "./compiled-cache.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { loadMemoryWikiVaultIdentity } from "./log.js";
import * as obsidian from "./obsidian.js";
import {
  buildMemoryWikiDoctorReport,
  renderMemoryWikiDoctor,
  renderMemoryWikiStatus,
  resolveMemoryWikiStatus,
} from "./status.js";
import {
  createCompiledSnapshot,
  createMemoryWikiTestHarness,
  publishCompiledSnapshot,
} from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

beforeEach(() => {
  vi.spyOn(obsidian, "probeObsidianCli").mockResolvedValue({ available: false, command: null });
});
afterEach(() => vi.restoreAllMocks());

describe("memory wiki status and doctor", () => {
  it("warns when unsafe-local is selected without explicit private access", async () => {
    const { config } = await createVault({ config: { vaultMode: "unsafe-local" } });
    const status = await resolveMemoryWikiStatus(config);
    expect(status.warnings.map((warning) => warning.code)).toContain("unsafe-local-disabled");
  });

  it.each(["agent", "global"] as const)(
    "reads the last %s publication without exporting or scanning, including during rebuild",
    async (scope) => {
      const { config: base } = await createVault({ initialize: true });
      const config = {
        ...base,
        vault: { ...base.vault, scope },
        ...(scope === "agent" ? { agentId: "support" } : {}),
        vaultMode: "bridge" as const,
        bridge: { ...base.bridge, enabled: true },
      };
      const identity = await loadMemoryWikiVaultIdentity(config.vault.path);
      activateMemoryWikiCompiledCacheOwner(config, identity.vaultGeneration!);
      const snapshot = createCompiledSnapshot();
      snapshot.dashboards.overview.pageCounts.source = 12_416;
      await publishCompiledSnapshot(config, snapshot);
      setMemoryWikiDashboardState(config, { state: "rebuilding" });
      const exportArtifacts = vi
        .spyOn(memoryHost, "listActiveMemoryPublicArtifacts")
        .mockRejectedValue(new Error("status must not export"));
      const walk = vi
        .spyOn(boundedWalk, "listMemoryWikiPagePaths")
        .mockRejectedValue(new Error("status must not scan"));

      const status = await resolveMemoryWikiStatus(config, {
        appConfig: {},
        callerAgentId: "support",
      });

      expect(status).toMatchObject({
        vaultScope: scope,
        agentId: scope === "agent" ? "support" : null,
        bridgePublicArtifactCount: null,
        snapshot: { state: "published", compiledAt: null },
        pageCounts: { source: 12_416 },
        sourceCounts: { native: null, bridge: null },
      });
      expect(exportArtifacts).not.toHaveBeenCalled();
      expect(walk).not.toHaveBeenCalled();
      expect(renderMemoryWikiStatus(status)).toContain("live export count not checked");
      expect(renderMemoryWikiStatus(status)).toContain("last publication, not current files");
    },
  );

  it("publishes provenance counts at compile and reads them from a cold offline process", async () => {
    const { config, page, write } = await createVault({ initialize: true });
    for (const [name, fields] of [
      ["native", {}],
      ["bridge", { sourceType: "memory-bridge" }],
      ["events", { sourceType: "memory-bridge-events" }],
      ["unsafe", { sourceType: "memory-unsafe-local", provenanceMode: "unsafe-local" }],
    ] as const) {
      await page(`sources/${name}.md`, {
        pageType: "source",
        id: `source.${name}`,
        title: name,
        ...fields,
      });
    }
    await write("sources/broken.md", "---\ninvalid: [unterminated\n---\n# Broken\n");
    await compileMemoryWikiVault(config);
    deactivateMemoryWikiCompiledCacheOwnersExcept(new Set());
    const walk = vi
      .spyOn(boundedWalk, "listMemoryWikiPagePaths")
      .mockRejectedValue(new Error("status must not scan"));

    const status = await resolveMemoryWikiStatus(config);

    expect(status.pageCounts.source).toBe(4);
    expect(status.sourceCounts).toEqual({
      native: 1,
      bridge: 1,
      bridgeEvents: 1,
      unsafeLocal: 1,
      other: 0,
    });
    expect(status.snapshot).toEqual({ state: "published", compiledAt: expect.any(String) });
    expect(walk).not.toHaveBeenCalled();
    expect(await loadMemoryWikiCompiledCache(config)).toBeNull();
  });

  it("keeps a quarantined owner unavailable instead of reviving its journal publication", async () => {
    const { config } = await createVault({ initialize: true });
    await publishCompiledSnapshot(config, createCompiledSnapshot());
    const identity = await loadMemoryWikiVaultIdentity(config.vault.path);
    activateMemoryWikiCompiledCacheOwner(config, identity.vaultGeneration!, null);

    const status = await resolveMemoryWikiStatus(config);

    expect(status.snapshot?.state).toBe("unavailable");
    expect(status.pageCounts.source).toBeNull();
    expect(buildMemoryWikiDoctorReport(status).healthy).toBe(false);
  });

  it("reports missing snapshots as unknown, without treating unknown exports as zero", async () => {
    const { config } = await createVault({
      initialize: true,
      config: { vaultMode: "bridge", bridge: { enabled: true } },
    });
    const status = await resolveMemoryWikiStatus(config, { appConfig: {} });
    const report = buildMemoryWikiDoctorReport(status);
    expect(status.bridgePublicArtifactCount).toBeNull();
    expect(Object.values(status.pageCounts)).toEqual([null, null, null, null, null]);
    expect(status.warnings.map((warning) => warning.code)).toEqual(["compiled-snapshot-missing"]);
    expect(report.healthy).toBe(false);
    expect(renderMemoryWikiDoctor(report)).toContain("unknown sources");
  });

  it("preserves numeric live counts and exporter health before any compile for released clients", async () => {
    const { config, page, write } = await createVault({
      initialize: true,
      config: { vaultMode: "bridge", bridge: { enabled: true, readMemoryArtifacts: true } },
    });
    await page("sources/native.md", { pageType: "source", title: "Native" });
    await page("sources/bridge.md", {
      pageType: "source",
      title: "Bridge",
      sourceType: "memory-bridge",
    });
    await write("sources/broken.md", "---\nbroken: [\n---\n");
    vi.spyOn(memoryHost, "listActiveMemoryPublicArtifacts").mockResolvedValue([]);
    const status = await resolveMemoryWikiStatus(config, { appConfig: {}, mode: "live" });
    expect(status.pageCounts).toEqual({
      entity: 0,
      concept: 0,
      source: 2,
      synthesis: 0,
      report: 0,
    });
    expect(status.sourceCounts).toEqual({
      native: 1,
      bridge: 1,
      bridgeEvents: 0,
      unsafeLocal: 0,
      other: 0,
    });
    expect(status.bridgePublicArtifactCount).toBe(0);
    expect(status.snapshot).toBeUndefined();
    expect(status.warnings.map(({ code }) => code)).toEqual(["bridge-artifacts-missing"]);
    expect(buildMemoryWikiDoctorReport(status).healthy).toBe(false);
  });

  it("reports snapshot read failures without scanning the vault", async () => {
    const { config } = await createVault({ initialize: true });
    vi.spyOn(compiledCache, "loadMemoryWikiDiagnosticSnapshot").mockRejectedValue(
      new Error("read failed"),
    );
    const walk = vi
      .spyOn(boundedWalk, "listMemoryWikiPagePaths")
      .mockRejectedValue(new Error("no fallback"));
    const status = await resolveMemoryWikiStatus(config);
    expect(status.snapshot?.state).toBe("failed");
    expect(status.warnings.map((warning) => warning.code)).toContain(
      "compiled-snapshot-unreadable",
    );
    expect(walk).not.toHaveBeenCalled();
  });

  it("includes configuration warnings in text output", async () => {
    vi.spyOn(securityRuntime, "pathExists").mockResolvedValue(false);
    const status = await resolveMemoryWikiStatus(
      resolveMemoryWikiConfig({
        vault: { path: "/tmp/wiki" },
        obsidian: { enabled: true, useOfficialCli: true },
      }),
    );
    expect(renderMemoryWikiStatus(status)).toContain("Wiki vault has not been initialized yet.");
    expect(buildMemoryWikiDoctorReport(status).fixes.map((fix) => fix.code)).toContain(
      "obsidian-cli-missing",
    );
  });
});
