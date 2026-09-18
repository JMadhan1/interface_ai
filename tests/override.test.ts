import { describe, expect, it } from "vitest";
import { generateLabelDriftOverride } from "../src/canon/override.js";
import type { Capability } from "../src/artifact/schema.js";

function capWithOpenSubAccountClick(): Capability {
  return {
    schemaVersion: "1.0",
    id: "cap_x",
    name: "Open sub-account",
    description: "test",
    version: 1,
    provenance: {
      goal: "open sub-account",
      targetBaseUrl: "http://localhost:4100/tenant-a",
      baseTenant: "tenant-a",
      model: "m",
      discoveryRunId: "d1",
      discoveredAt: new Date().toISOString(),
    },
    inputParams: [],
    steps: [
      {
        stepId: "s_click_open",
        action: "click",
        intent: "open the new sub-account form",
        riskLevel: "safe",
        locators: [{ kind: "role", role: "button", name: "Open Sub-Account", confidence: 0.9, rationale: "r" }],
      },
    ],
    sessionBootstrapStepCount: 0,
    knownInterstitials: [],
    businessOutcomes: [],
    outputs: [],
    successCheckpoint: { kind: "textPresent", text: "done" },
  };
}

describe("generateLabelDriftOverride", () => {
  it("produces a locator override for the step whose label drifted on the target tenant", () => {
    const override = generateLabelDriftOverride(capWithOpenSubAccountClick(), "tenant-b");
    expect(override.forTenant).toBe("tenant-b");
    expect(override.locatorOverrides["s_click_open"]).toBeDefined();
    expect(override.locatorOverrides["s_click_open"]![0]!.kind).toBe("role");
    expect((override.locatorOverrides["s_click_open"]![0] as any).name).toBe("Create New Sub-Account");
  });

  it("produces no override when tenant labels don't differ", () => {
    const cap = capWithOpenSubAccountClick();
    cap.provenance.baseTenant = "tenant-a";
    const override = generateLabelDriftOverride(cap, "tenant-a");
    expect(Object.keys(override.locatorOverrides)).toHaveLength(0);
  });
});
