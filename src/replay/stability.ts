import { mkdirSync, writeFileSync } from "node:fs";
import type { Capability, TenantOverride } from "../artifact/schema.js";
import type { AllowlistConfig } from "../safety/allowlist.js";
import { launchSurface } from "../surface/browser.js";
import { replayCapability, type ReplayResult } from "./executor.js";

// ---------------------------------------------------------------------------
// Multi-run stability signal (brief §8 stretch goal: "replay N times and
// report a stability/flakiness signal"). A capability that replayed once
// during curation isn't the same claim as a capability that reliably
// replays — this is the difference between "it worked" and "it works."
//
// Deliberately minimal: this reports what actually happened across N
// independent runs (status distribution, timing, first-divergence point). It
// does not attempt automated tenant-drift *detection* — that's a larger,
// separate problem (see REPORT.md §4) this signal only feeds evidence into.
// ---------------------------------------------------------------------------

export interface StabilityRunSummary {
  runIndex: number;
  status: ReplayResult["status"];
  stepsExecuted: number | null;
  recoveryEventCount: number;
  durationMs: number;
  detail?: string;
}

export interface StabilityReport {
  capabilityId: string;
  capabilityVersion: number;
  totalRuns: number;
  statusCounts: Record<string, number>;
  successRate: number; // successes / totalRuns
  allIdentical: boolean; // did every run land on the same status?
  runs: StabilityRunSummary[];
  generatedAt: string;
}

export async function runStabilityCheck(opts: {
  capability: Capability;
  params: Record<string, string | number | boolean>;
  allowlist: AllowlistConfig;
  evidenceDir: string;
  runs: number;
  tenantOverride?: TenantOverride;
}): Promise<StabilityReport> {
  const runs: StabilityRunSummary[] = [];

  for (let i = 0; i < opts.runs; i++) {
    const { page, close } = await launchSurface();
    const startedAt = Date.now();
    try {
      const result = await replayCapability({
        page,
        capability: opts.capability,
        params: opts.params,
        allowlist: opts.allowlist,
        evidenceDir: `${opts.evidenceDir}/run_${i}`,
        tenantOverride: opts.tenantOverride,
        riskyStepPolicy: "auto",
        autoResumeEscalations: true,
      });
      const durationMs = Date.now() - startedAt;
      runs.push({
        runIndex: i,
        status: result.status,
        stepsExecuted: "stepsExecuted" in result ? result.stepsExecuted : null,
        recoveryEventCount: "recoveryEvents" in result ? result.recoveryEvents.length : 0,
        durationMs,
        detail: result.status === "business_outcome" ? result.code : result.status === "hard_failure" ? `${result.stepId}: ${result.observed}` : undefined,
      });
    } finally {
      await close();
    }
  }

  const report: StabilityReport = {
    capabilityId: opts.capability.id,
    capabilityVersion: opts.capability.version,
    totalRuns: opts.runs,
    ...summarizeStabilityRuns(runs, opts.runs),
    runs,
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(opts.evidenceDir, { recursive: true });
  writeFileSync(`${opts.evidenceDir}/stability-report.json`, JSON.stringify(report, null, 2), "utf-8");

  return report;
}

/** Pure aggregation, split out from runStabilityCheck (which needs a real browser) so it's unit-testable on its own. */
export function summarizeStabilityRuns(
  runs: Pick<StabilityRunSummary, "status">[],
  totalRuns: number
): { statusCounts: Record<string, number>; successRate: number; allIdentical: boolean } {
  const statusCounts: Record<string, number> = {};
  for (const r of runs) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  return {
    statusCounts,
    successRate: totalRuns > 0 ? (statusCounts["success"] ?? 0) / totalRuns : 0,
    allIdentical: new Set(runs.map((r) => r.status)).size <= 1,
  };
}
