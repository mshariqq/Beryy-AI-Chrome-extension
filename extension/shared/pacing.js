import { isMutating, permissionTypeForTool } from "./policy.js";

const UNPACED_COMPUTER_ACTIONS = new Set(["screenshot", "zoom", "wait"]);

export function shouldPaceAction(tool, args = {}) {
  if (tool === "tabs_context_mcp") return false;

  if (tool === "computer") {
    return !UNPACED_COMPUTER_ACTIONS.has(String(args.action || ""));
  }

  if (tool === "tabs_create_mcp") return true;

  return isMutating(permissionTypeForTool(tool, args));
}

export function nextActionDelay(settings, tool, args = {}, random = Math.random) {
  if (!settings?.antiBotGuard || !shouldPaceAction(tool, args)) return 0;

  const base = Math.max(0, Number(settings.actionDelayMs) || 0);
  if (!base) return 0;

  const sample = Number(random());
  const bounded = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return base + Math.floor(base * 0.5 * bounded);
}
