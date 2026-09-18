import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ActionStep, RiskLevel } from "../artifact/schema.js";

// Explicit, configurable allowlist. Loaded from allowlist.config.json at the
// repo root (or a path passed on the CLI) — never hardcoded, so it can be
// reviewed and changed without touching code.

export const AllowlistConfigSchema = z.object({
  allowedOrigins: z.array(z.string()), // e.g. "http://localhost:4100"
  allowedActionTypes: z.array(z.string()), // action kinds the agent/replay may ever perform
  riskyActionTypes: z.array(z.string()), // subset that requires explicit confirmation/approval
  maxStepsPerRun: z.number().int().positive(),
});
export type AllowlistConfig = z.infer<typeof AllowlistConfigSchema>;

export const DEFAULT_ALLOWLIST: AllowlistConfig = {
  allowedOrigins: ["http://localhost:4100"],
  allowedActionTypes: ["navigate", "click", "fill", "select", "waitForText", "extract", "assertCheckpoint"],
  riskyActionTypes: ["fill", "select"], // anything that mutates state is treated conservatively
  maxStepsPerRun: 40,
};

export function loadAllowlistConfig(path = "src/safety/allowlist.config.json"): AllowlistConfig {
  try {
    return AllowlistConfigSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return DEFAULT_ALLOWLIST;
  }
}

export class PolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

export function assertOriginAllowed(url: string, config: AllowlistConfig): void {
  const origin = new URL(url).origin;
  if (!config.allowedOrigins.includes(origin)) {
    throw new PolicyViolation(`origin not in allowlist: ${origin}`);
  }
}

export function assertActionTypeAllowed(actionType: string, config: AllowlistConfig): void {
  if (!config.allowedActionTypes.includes(actionType)) {
    throw new PolicyViolation(`action type not in allowlist: ${actionType}`);
  }
}

/**
 * Risk classification for a recorded step. Safe/reversible actions (reads,
 * navigation) may replay unattended. Risky actions (anything that writes —
 * fill/select feeding a submit, i.e. mutating state) are flagged so the
 * replay engine can require pre-approval or pause for confirmation rather
 * than silently executing an irreversible bank operation.
 */
export function classifyRisk(action: ActionStep["action"], config: AllowlistConfig = DEFAULT_ALLOWLIST): RiskLevel {
  return config.riskyActionTypes.includes(action) ? "risky" : "safe";
}
