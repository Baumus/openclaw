import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy-shared.js";
import { isGoalExecutionPolicy, type GoalExecutionPolicy } from "./goal-continuation.types.js";

type RuntimePolicy = {
  toolsAllow?: string[];
  disableTools?: boolean;
  forceRestartSafeTools?: boolean;
  forceCodeModeTools?: boolean;
};

/** JSON must preserve independent glob caps, including an explicit empty cap. */
export function captureGoalExecutionPolicy(source: RuntimePolicy): GoalExecutionPolicy {
  return {
    ...(source.toolsAllow === undefined
      ? {}
      : {
          toolsAllow: (readToolAllowlistIntersection(source.toolsAllow) ?? [source.toolsAllow]).map(
            (group) => group.slice(),
          ),
        }),
    ...(source.disableTools ? { disableTools: true } : {}),
    ...(source.forceRestartSafeTools ? { forceRestartSafeTools: true } : {}),
    ...(source.forceCodeModeTools ? { forceCodeModeTools: true } : {}),
  };
}

/** Fresh policy remains in force; recovery can only retain additional source restrictions. */
export function restoreGoalExecutionPolicy(
  saved: unknown,
  current: RuntimePolicy = {},
): RuntimePolicy {
  if (!isGoalExecutionPolicy(saved)) {
    throw new Error(
      "Saved Goal continuation lacks a valid source execution policy; use /goal resume.",
    );
  }
  const currentPolicy = captureGoalExecutionPolicy(current);
  const groups = [...(saved.toolsAllow ?? []), ...(currentPolicy.toolsAllow ?? [])].map((group) =>
    group.slice(),
  );
  return {
    ...(groups.length
      ? { toolsAllow: attachToolAllowlistIntersection([...new Set(groups.flat())], groups) }
      : {}),
    disableTools: saved.disableTools === true || current.disableTools === true,
    forceRestartSafeTools:
      saved.forceRestartSafeTools === true || current.forceRestartSafeTools === true,
    forceCodeModeTools: saved.forceCodeModeTools === true || current.forceCodeModeTools === true,
  };
}
