// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import * as catalogAccess from "./prepared-model-runtime.catalog-access.js";
import {
  acquirePublishedPreparedModelRuntime,
  refreshPreparedModelRuntimeSnapshots,
  markPreparedModelRuntimeSnapshotsStale,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "generation-construction-custody" });

it.each([false, true])(
  "owns a new generation through prepublication catalog work (discard=%s)",
  async (discard) => {
    const registry = createEmptyPluginRegistry();
    fixture.mocks.configuredAgentIds = ["default"];
    fixture.mocks.authStorage.getAll.mockReturnValue({});
    fixture.mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    const createAccess = catalogAccess.createFullModelCatalogAccess;
    const observation = vi
      .spyOn(catalogAccess, "createFullModelCatalogAccess")
      .mockImplementation(async (...args) => {
        const access = await createAccess(...args);
        // A completed background retry is finite work, not the unpublished generation's owner.
        await access.loadFullModelCatalog({ refresh: true, wait: true });
        if (discard) {
          throw new Error("construction failed after catalog work");
        }
        return access;
      });
    const config = {};
    try {
      const publication = refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      if (discard) {
        await expect(publication).rejects.toThrow("construction failed after catalog work");
        expect(isPluginRegistryRetired(registry)).toBe(true);
      } else {
        await publication;
        await using lease = await acquirePublishedPreparedModelRuntime(
          fixture.agentInput("default", config),
        );
        expect(lease.snapshot.pluginRegistry).toBe(registry);
        expect(isPluginRegistryRetired(registry)).toBe(false);
        await lease[Symbol.asyncDispose]();
        markPreparedModelRuntimeSnapshotsStale("construction ownership transferred");
        await expect.poll(() => isPluginRegistryRetired(registry)).toBe(true);
      }
    } finally {
      observation.mockRestore();
    }
  },
);
