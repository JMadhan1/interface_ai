import { describe, expect, it } from "vitest";
import { summarizeStabilityRuns } from "../src/replay/stability.js";

describe("summarizeStabilityRuns", () => {
  it("reports 100% success rate and allIdentical when every run succeeds", () => {
    const runs = [{ status: "success" as const }, { status: "success" as const }, { status: "success" as const }];
    const summary = summarizeStabilityRuns(runs, 3);
    expect(summary.successRate).toBe(1);
    expect(summary.allIdentical).toBe(true);
    expect(summary.statusCounts).toEqual({ success: 3 });
  });

  it("computes a partial success rate and flags non-identical outcomes when runs disagree", () => {
    const runs = [{ status: "success" as const }, { status: "hard_failure" as const }, { status: "success" as const }];
    const summary = summarizeStabilityRuns(runs, 3);
    expect(summary.successRate).toBeCloseTo(2 / 3);
    expect(summary.allIdentical).toBe(false);
    expect(summary.statusCounts).toEqual({ success: 2, hard_failure: 1 });
  });

  it("does not divide by zero when there are no runs", () => {
    const summary = summarizeStabilityRuns([], 0);
    expect(summary.successRate).toBe(0);
    expect(summary.allIdentical).toBe(true);
  });

  it("treats a consistent non-success outcome (e.g. always the same business outcome) as stable", () => {
    const runs = [{ status: "business_outcome" as const }, { status: "business_outcome" as const }];
    const summary = summarizeStabilityRuns(runs, 2);
    expect(summary.successRate).toBe(0);
    expect(summary.allIdentical).toBe(true);
  });
});
