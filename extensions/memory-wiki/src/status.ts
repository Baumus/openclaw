import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiVaultAgentId } from "./bridge.js";
import {
  loadMemoryWikiDiagnosticSnapshot,
  type MemoryWikiCompiledCacheSnapshot,
  type MemoryWikiSourceCounts,
} from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { probeObsidianCli } from "./obsidian.js";
import type { WikiPageKind } from "./wiki-page-kinds.js";

const STATUS_WARNING_FIXES = {
  "vault-missing": "Run `openclaw wiki init` to create the vault layout.",
  "obsidian-cli-missing": "Install the official Obsidian CLI or disable `obsidian.useOfficialCli`.",
  "bridge-disabled":
    "Enable `plugins.entries.memory-wiki.config.bridge.enabled` or switch vaultMode away from `bridge`.",
  "compiled-snapshot-missing":
    "Run `openclaw wiki compile` to publish a snapshot; use `openclaw wiki bridge import` to refresh bridge inputs first.",
  "compiled-snapshot-unreadable":
    "Inspect the plugin state read error, then run `openclaw wiki compile` if the snapshot needs rebuilding.",
  "unsafe-local-disabled":
    "Enable `unsafeLocal.allowPrivateMemoryCoreAccess` or switch vaultMode away from `unsafe-local`.",
  "unsafe-local-paths-missing":
    "Add explicit `unsafeLocal.paths` entries before running unsafe-local imports.",
  "unsafe-local-without-mode":
    "Disable private memory-core access unless you explicitly want unsafe-local mode.",
};

type MemoryWikiStatusWarning = {
  code: keyof typeof STATUS_WARNING_FIXES;
  message: string;
};

export type MemoryWikiStatus = Awaited<ReturnType<typeof resolveMemoryWikiStatus>>;

export type MemoryWikiDoctorReport = ReturnType<typeof buildMemoryWikiDoctorReport>;

type MemoryWikiStatusOptions = {
  appConfig?: OpenClawConfig;
  callerAgentId?: string;
};

function unknownCounts() {
  const pageCounts: Record<WikiPageKind, number | null> = {
    entity: null,
    concept: null,
    source: null,
    synthesis: null,
    report: null,
  };
  const sourceCounts: { [K in keyof MemoryWikiSourceCounts]: number | null } = {
    native: null,
    bridge: null,
    bridgeEvents: null,
    unsafeLocal: null,
    other: null,
  };
  return { pageCounts, sourceCounts };
}

export async function resolveMemoryWikiStatus(
  config: ResolvedMemoryWikiConfig,
  _options?: MemoryWikiStatusOptions,
) {
  const agentId = resolveMemoryWikiVaultAgentId(config);
  const vaultExists = await pathExists(config.vault.path);
  // Public artifact enumeration can materialize exports. Diagnostics deliberately
  // leave that live count unknown, independently of imported source-page counts.
  const obsidianProbe = await probeObsidianCli();
  let published: MemoryWikiCompiledCacheSnapshot | null = null;
  let snapshotState: "published" | "unavailable" | "failed" = "unavailable";
  if (vaultExists) {
    try {
      published = await loadMemoryWikiDiagnosticSnapshot(config);
      snapshotState = published ? "published" : "unavailable";
    } catch {
      snapshotState = "failed";
    }
  }
  const counts = unknownCounts();
  if (published) {
    Object.assign(counts.pageCounts, published.dashboards.overview.pageCounts);
    if (published.diagnostics) {
      Object.assign(counts.sourceCounts, published.diagnostics.sourceCounts);
    }
  }

  const rules: Array<[boolean, MemoryWikiStatusWarning["code"], string]> = [
    [!vaultExists, "vault-missing", "Wiki vault has not been initialized yet."],
    [
      config.obsidian.enabled && config.obsidian.useOfficialCli && !obsidianProbe.command,
      "obsidian-cli-missing",
      "Obsidian CLI is enabled in config but `obsidian` is not available on PATH.",
    ],
    [
      config.vaultMode === "bridge" && !config.bridge.enabled,
      "bridge-disabled",
      "vaultMode is `bridge` but bridge.enabled is false.",
    ],
    [
      vaultExists && snapshotState === "unavailable",
      "compiled-snapshot-missing",
      "No published wiki snapshot is available; page counts are unknown.",
    ],
    [
      vaultExists && snapshotState === "failed",
      "compiled-snapshot-unreadable",
      "The published wiki snapshot could not be read; page counts are unknown.",
    ],
    [
      config.vaultMode === "unsafe-local" && !config.unsafeLocal.allowPrivateMemoryCoreAccess,
      "unsafe-local-disabled",
      "vaultMode is `unsafe-local` but private memory-core access is disabled.",
    ],
    [
      config.vaultMode === "unsafe-local" &&
        config.unsafeLocal.allowPrivateMemoryCoreAccess &&
        config.unsafeLocal.paths.length === 0,
      "unsafe-local-paths-missing",
      "unsafe-local access is enabled but no private paths are configured.",
    ],
    [
      config.vaultMode !== "unsafe-local" && config.unsafeLocal.allowPrivateMemoryCoreAccess,
      "unsafe-local-without-mode",
      "Private memory-core access is enabled outside unsafe-local mode.",
    ],
  ];

  return {
    vaultScope: config.vault.scope,
    agentId,
    vaultMode: config.vaultMode,
    renderMode: config.vault.renderMode,
    vaultPath: config.vault.path,
    vaultExists,
    bridge: config.bridge,
    bridgePublicArtifactCount: null as number | null,
    snapshot: {
      state: snapshotState,
      compiledAt: published?.diagnostics?.compiledAt ?? null,
    },
    obsidianCli: {
      enabled: config.obsidian.enabled,
      requested: config.obsidian.enabled && config.obsidian.useOfficialCli,
      available: obsidianProbe.available,
      command: obsidianProbe.command,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: config.unsafeLocal.allowPrivateMemoryCoreAccess,
      pathCount: config.unsafeLocal.paths.length,
    },
    pageCounts: counts.pageCounts,
    sourceCounts: counts.sourceCounts,
    warnings: rules.flatMap(([matches, code, message]) => (matches ? [{ code, message }] : [])),
  };
}

export function buildMemoryWikiDoctorReport(status: MemoryWikiStatus) {
  const fixes = status.warnings.map((warning) => ({
    code: warning.code,
    message: STATUS_WARNING_FIXES[warning.code],
  }));
  return {
    healthy: status.warnings.length === 0,
    warningCount: status.warnings.length,
    status,
    fixes,
  };
}

export function renderMemoryWikiStatus(
  status: MemoryWikiStatus,
  text: (value: string) => string = String,
): string {
  const count = (value: number | null) => (value === null ? "unknown" : String(value));
  const lines = [
    `Wiki vault mode: ${text(status.vaultMode)}`,
    `Vault scope: ${text(status.vaultScope)}${status.agentId ? ` (${text(status.agentId)})` : ""}`,
    `Vault: ${status.vaultExists ? "ready" : "missing"} (${text(status.vaultPath)})`,
    `Render mode: ${text(status.renderMode)}`,
    `Obsidian CLI: ${status.obsidianCli.available ? "available" : "missing"}${status.obsidianCli.requested ? " (requested)" : ""}`,
    `Bridge: ${status.bridge.enabled ? "enabled" : "disabled"}${status.bridgePublicArtifactCount !== null ? ` (${status.bridgePublicArtifactCount} exported artifact${status.bridgePublicArtifactCount === 1 ? "" : "s"})` : " (live export count not checked)"}`,
    `Unsafe local: ${status.unsafeLocal.allowPrivateMemoryCoreAccess ? `enabled (${status.unsafeLocal.pathCount} paths)` : "disabled"}`,
    ...(status.snapshot
      ? [
          `Snapshot: ${status.snapshot.state}${status.snapshot.compiledAt ? ` (${text(status.snapshot.compiledAt)})` : " (compile time unknown)"}; counts describe the last publication, not current files`,
        ]
      : []),
    `Pages: ${count(status.pageCounts.source)} sources, ${count(status.pageCounts.entity)} entities, ${count(status.pageCounts.concept)} concepts, ${count(status.pageCounts.synthesis)} syntheses, ${count(status.pageCounts.report)} reports`,
    `Source provenance: ${count(status.sourceCounts.native)} native, ${count(status.sourceCounts.bridge)} bridge, ${count(status.sourceCounts.bridgeEvents)} bridge-events, ${count(status.sourceCounts.unsafeLocal)} unsafe-local, ${count(status.sourceCounts.other)} other`,
  ];

  if (status.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of status.warnings) {
      lines.push(`- ${text(warning.message)}`);
    }
  }

  return lines.join("\n");
}

export function renderMemoryWikiDoctor(
  report: MemoryWikiDoctorReport,
  text: (value: string) => string = String,
): string {
  const lines = [
    report.healthy ? "Wiki doctor: healthy" : `Wiki doctor: ${report.warningCount} issue(s) found`,
    "",
    renderMemoryWikiStatus(report.status, text),
  ];

  if (report.fixes.length > 0) {
    lines.push("", "Suggested fixes:");
    for (const fix of report.fixes) {
      lines.push(`- ${text(fix.message)}`);
    }
  }

  return lines.join("\n");
}
