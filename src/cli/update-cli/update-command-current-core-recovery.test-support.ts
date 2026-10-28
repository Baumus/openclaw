import { expect } from "vitest";
import type { UpdateCommandOptions } from "./shared.js";
import { withCurrentCoreRestoration } from "./update-command-current-core-recovery.js";

// Obtain the serialized restriction through the production restoration boundary.
export async function captureRestorationRisk(run: NonNullable<UpdateCommandOptions["run"]>) {
  return withCurrentCoreRestoration({
    enabled: true,
    run,
    result: { status: "ok", mode: "npm", steps: [], durationMs: 0 },
    restore: async (risk) => {
      expect(risk).toBeDefined();
      if (!risk) {
        throw new Error("Restoration did not capture its current-core restriction.");
      }
      return risk;
    },
    failure: (cause) => new Error("Unable to capture restoration restriction.", { cause }),
  });
}
