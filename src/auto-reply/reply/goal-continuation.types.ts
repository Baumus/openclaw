/** Exact Goal and session generation, shared by queue custody and durable recovery. */
export type GoalContinuation = {
  sessionId: string;
  lifecycleRevision?: string;
  goalId: string;
  workerGoal?: true;
  executionPolicy?: GoalExecutionPolicy;
};

/** Independent source caps, retained as data across process loss. */
export type GoalExecutionPolicy = {
  toolsAllow?: string[][];
  disableTools?: boolean;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
};

export function isGoalExecutionPolicy(value: unknown): value is GoalExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const policy = value as Record<string, unknown>;
  return (
    (policy.toolsAllow === undefined ||
      (Array.isArray(policy.toolsAllow) &&
        policy.toolsAllow.length > 0 &&
        policy.toolsAllow.every(
          (group: unknown) =>
            Array.isArray(group) && group.every((name: unknown) => typeof name === "string"),
        ))) &&
    ["disableTools", "forceRestartSafeTools", "forceCodeModeTools"].every(
      (key) => policy[key] === undefined || typeof policy[key] === "boolean",
    )
  );
}
