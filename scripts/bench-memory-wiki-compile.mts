// Run: node --import tsx scripts/bench-memory-wiki-compile.mts <gateway-entry.mjs>
//   <baseline-plugin-dir> <candidate-plugin-dir> <output.json> [pages=1000] [samples=5]
// Acceptance: identical page counts and generated content after each edit; fewer
// compiler page reads (separate compiler work-count fixture); warm RPC median/p95
// must not regress by 20%. Cold initial compiles are reported separately.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import { delay, stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import { createGatewayBenchEnv } from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const [entry, baseline, candidate, output, pagesRaw = "1000", samplesRaw = "5"] =
  process.argv.slice(2);
assert(entry && baseline && candidate && output, "Expected entry, baseline, candidate, output");
const pages = Number(pagesRaw);
const samples = Number(samplesRaw);
assert(Number.isInteger(pages) && pages > 0 && Number.isInteger(samples) && samples > 0);
// openclaw-temp-dir: allow benchmark owns an isolated Gateway home and synthetic vault.
const root = await fs.mkdtemp(path.join(tmpdir(), "wiki-compile-bench-"));
const arms: Array<{
  name: string;
  vault: string;
  child: ChildProcess;
  client: ReturnType<typeof createGatewayWsClient> | undefined;
  log: () => string;
}> = [];
const evidence = {
  pages,
  samples,
  load: loadavg(),
  status: "incomplete",
  identities: {},
  cold: [],
  warm: [],
} as {
  status: string;
  identities: Record<string, { version: string; digest: string }>;
  pages: number;
  samples: number;
  load: number[];
  cold: Array<{ arm: string; ms: number }>;
  warm: Array<{
    arm: string;
    sample: number;
    ms: number;
    digest: string;
    pageCounts: unknown;
    load: number[];
  }>;
};
async function generatedDigest(vault: string) {
  const digest = createHash("sha256");
  digest.update(await fs.readFile(path.join(vault, "index.md")));
  for (const dir of ["entities", "concepts", "sources", "syntheses", "reports"]) {
    for (const name of (await fs.readdir(path.join(vault, dir))).toSorted()) {
      const raw = await fs.readFile(path.join(vault, dir, name), "utf8");
      digest
        .update(`${dir}/${name}\n`)
        .update(raw.replace(/^updatedAt:.*$/gm, "updatedAt: <clock>"));
    }
  }
  return digest.digest("hex");
}
async function identify(directory: string) {
  const digest = createHash("sha256");
  async function walk(relative: string) {
    for (const item of (
      await fs.readdir(path.join(directory, relative), { withFileTypes: true })
    ).toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === "node_modules" || item.name === ".git") {
        continue;
      }
      const file = path.join(relative, item.name);
      if (item.isDirectory()) {
        await walk(file);
      } else if (item.isFile() && /\.(?:m?js|json)$/.test(file)) {
        digest.update(file).update(await fs.readFile(path.join(directory, file)));
      }
    }
  }
  await walk("");
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  return { version: String(manifest.version), digest: digest.digest("hex") };
}
evidence.identities.host = await identify(path.dirname(path.resolve(entry)));
try {
  for (const [name, plugin] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    evidence.identities[name] = await identify(path.resolve(plugin));
    const home = path.join(root, name);
    const vault = path.join(home, "wiki");
    await fs.mkdir(home, { recursive: true });
    const port = await getFreePort();
    const token = "synthetic-wiki-compile-benchmark-token";
    const configPath = path.join(home, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        browser: { enabled: false },
        update: { checkOnStart: false },
        discovery: { mdns: { mode: "off" } },
        gateway: {
          mode: "local",
          port,
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          tailscale: { mode: "off" },
        },
        agents: { defaults: { workspace: path.join(home, "workspace") } },
        plugins: {
          allow: ["memory-wiki"],
          slots: { memory: "none" },
          load: { paths: [path.resolve(plugin)] },
          entries: {
            "memory-wiki": {
              enabled: true,
              config: {
                vaultMode: "isolated",
                vault: { path: vault, renderMode: "native" },
                obsidian: { enabled: false },
                bridge: { enabled: false },
                ingest: { autoCompile: false },
              },
            },
          },
        },
      }),
    );
    const child = spawn(
      process.execPath,
      [path.resolve(entry), "gateway", "run", "--port", String(port)],
      {
        env: createGatewayBenchEnv(home, configPath, {}),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    let logs = "";
    child.stdout.on("data", (chunk) => {
      logs += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      logs += String(chunk);
    });
    let client: ReturnType<typeof createGatewayWsClient> | undefined;
    arms.push({
      name,
      vault,
      child,
      get client() {
        return client;
      },
      log: () => logs,
    });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`${name} Gateway exited: ${logs.slice(-6000)}`);
      }
      const probe = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
      try {
        await probe.waitOpen();
        const connected = await probe.request("connect", {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "gateway-client",
            displayName: "wiki-compile-benchmark",
            version: "1.0.0",
            platform: process.platform,
            mode: "backend",
          },
          role: "operator",
          auth: { token },
          scopes: ["operator.read", "operator.write", "operator.admin"],
          caps: [],
        });
        assert(connected.ok, JSON.stringify(connected.error));
        client = probe;
        break;
      } catch {
        probe.close();
        await delay(500);
      }
    }
    assert(client, `${name} Gateway readiness timeout: ${logs.slice(-6000)}`);
    const init = await client.request("wiki.init", {}, 120_000);
    assert(init.ok, JSON.stringify(init.error));
    for (let i = 0; i < pages; i++) {
      await fs.writeFile(
        path.join(vault, "sources", `page-${i}.md`),
        `---\npageType: source\nid: source.${i}\ntitle: Source ${i}\n---\n# Source ${i}\n\nSynthetic source body.\n`,
      );
    }
    const started = performance.now();
    const compiled = await client.request("wiki.compile", {}, 300_000);
    assert(compiled.ok, JSON.stringify(compiled.error));
    evidence.cold.push({ arm: name, ms: performance.now() - started });
  }
  for (let sample = 0; sample < samples; sample++) {
    const hashes: string[] = [];
    const counts: unknown[] = [];
    for (const arm of arms) {
      await fs.writeFile(
        path.join(arm.vault, "entities", "change.md"),
        `---\npageType: entity\nid: entity.change\ntitle: Changed ${sample}\nquestions:\n  - Question ${sample}?\n---\n# Changed ${sample}\n\n[Source](../sources/page-0.md)\n`,
      );
      const started = performance.now();
      assert(arm.client);
      const response = await arm.client.request("wiki.compile", {}, 300_000);
      assert(response.ok, JSON.stringify(response.error));
      const ms = performance.now() - started;
      assert(
        response.payload &&
          typeof response.payload === "object" &&
          "pageCounts" in response.payload,
      );
      counts.push(response.payload.pageCounts);
      const digest = await generatedDigest(arm.vault);
      hashes.push(digest);
      evidence.warm.push({
        arm: arm.name,
        sample,
        ms,
        digest,
        pageCounts: response.payload.pageCounts,
        load: loadavg(),
      });
      console.log(JSON.stringify(evidence.warm.at(-1)));
    }
    assert.deepEqual(counts[0], counts[1], `Page counts differ in sample ${sample}`);
    assert.equal(hashes[0], hashes[1], `Generated content differs in sample ${sample}`);
  }
  evidence.status = "complete";
} finally {
  for (const arm of arms) {
    arm.client?.close();
    await stopChild(arm.child, { teardownGraceMs: 30_000 });
    await fs.writeFile(`${output}.${arm.name}.log`, arm.log());
  }
  await fs.writeFile(output, JSON.stringify(evidence, null, 2));
  await fs.rm(root, { recursive: true, force: true });
}
