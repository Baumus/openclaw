import { expect, it } from "vitest";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy-shared.js";
import { captureGoalExecutionPolicy, restoreGoalExecutionPolicy } from "./goal-execution-policy.js";

it("intersects recovered source glob caps with current caps before executing effects", async () => {
  const saved = captureGoalExecutionPolicy({
    toolsAllow: attachToolAllowlistIntersection(
      [],
      [
        ["r*", "write"],
        ["*ad", "write"],
      ],
    ),
    forceRestartSafeTools: true,
  });
  const serializedPolicy = JSON.stringify(saved);
  const recovered = restoreGoalExecutionPolicy(JSON.parse(serializedPolicy), {
    toolsAllow: ["read", "exec"],
    forceCodeModeTools: true,
  });
  const effects: string[] = [];
  const tools = ["read", "write", "exec"].map((name) => ({
    name,
    execute: async () => {
      effects.push(name);
    },
  }));
  for (const tool of applyEmbeddedAttemptToolsAllow(tools, recovered.toolsAllow)) {
    await tool.execute();
  }
  expect(effects).toEqual(["read"]);
  expect(recovered.forceRestartSafeTools).toBe(true);
  expect(recovered.forceCodeModeTools).toBe(true);
});

it.each([undefined, null, { toolsAllow: [] }, { toolsAllow: [[1]] }, { disableTools: "false" }])(
  "refuses a missing or malformed durable policy (%j)",
  (policy) => {
    expect(() => restoreGoalExecutionPolicy(policy)).toThrow("source execution policy");
  },
);

it("retains disabled tools even when the current source allows them", () => {
  expect(
    restoreGoalExecutionPolicy({ disableTools: true }, { toolsAllow: ["*"] }).disableTools,
  ).toBe(true);
  expect(restoreGoalExecutionPolicy({}, { disableTools: true }).disableTools).toBe(true);
});
