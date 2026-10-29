import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { waitForMemoryWikiImportedSourceSyncs } from "./source-sync.js";
import { createWikiSearchTool } from "./tool.js";

const mocks = vi.hoisted(() => ({ bridge: vi.fn(), refresh: vi.fn(), query: vi.fn() }));
// Keep the real source-sync coordinator; control only importer/compiler I/O.
vi.mock("./bridge.js", () => ({ syncMemoryWikiBridgeSources: mocks.bridge }));
vi.mock("./compile.js", () => ({ refreshMemoryWikiIndexesAfterImport: mocks.refresh }));
vi.mock("./query.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./query.js")>()),
  searchMemoryWiki: mocks.query,
}));

afterEach(async () => {
  await waitForMemoryWikiImportedSourceSyncs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("wiki search maintenance ownership", () => {
  it.each(["deadline", "caller", "service"] as const)(
    "settles maintenance independently of %s cancellation and shares recovery",
    async (cause) => {
      vi.useFakeTimers();
      const lifecycle = new AbortController();
      const caller = new AbortController();
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let maintenanceSignal: AbortSignal | undefined;
      let published = false;
      mocks.bridge.mockResolvedValue({
        importedCount: 0,
        updatedCount: 0,
        removedCount: 0,
        skippedCount: 1,
        artifactCount: 1,
        workspaces: 1,
        pagePaths: [],
      });
      mocks.refresh.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
        maintenanceSignal = signal;
        started.resolve();
        await finish.promise;
        signal?.throwIfAborted();
        published = true;
        return { refreshed: true, reason: "missing-compiled-cache", compile: { updatedFiles: [] } };
      });
      mocks.query.mockResolvedValue([]);
      const config = resolveMemoryWikiConfig({
        vaultMode: "bridge",
        vault: { path: `/tmp/wiki-maintenance-${cause}` },
      });
      const tool = createWikiSearchTool(config, undefined, { signal: lifecycle.signal });
      const first = tool.execute("first", { query: "project-alpha" }, caller.signal);
      const firstFailure = first.catch((error: unknown) => error);
      await started.promise;
      // A second caller must join the same repair, not enqueue another compile.
      const second = tool.execute("second", { query: "project-alpha" });
      const secondResult = second.catch((error: unknown) => error);
      if (cause === "deadline") {
        await vi.advanceTimersByTimeAsync(30_000);
      } else {
        (cause === "service" ? lifecycle : caller).abort(new Error("cancelled"));
      }
      const failure = await firstFailure;
      const observedSignal = maintenanceSignal;
      finish.resolve();
      await secondResult;
      await waitForMemoryWikiImportedSourceSyncs();
      expect(failure).toBeInstanceOf(Error);
      expect(published).toBe(cause !== "service");
      expect(observedSignal).toBe(lifecycle.signal);
      expect(observedSignal?.aborted).toBe(cause === "service");
      expect(mocks.bridge).toHaveBeenCalledTimes(1);
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      expect(mocks.query).toHaveBeenCalledTimes(cause === "caller" ? 1 : 0);
    },
  );
});
