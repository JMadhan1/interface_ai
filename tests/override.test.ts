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
        stepId: "s_fill_member_id",
        action: "fill",
        intent: "enter member id",
        riskLevel: "risky",
        locators: [{ kind: "label", label: "Member ID", confidence: 0.9, rationale: "r" }],
        value: "{{memberId}}",
        sensitive: false,
      },
      {
        stepId: "s_click_open",
        action: "click",
        intent: "open the new sub-account form",
        riskLevel: "safe",
        locators: [{ kind: "role", role: "button", name: "Open Sub-Account", confidence: 0.9, rationale: "r" }],
      },
      {
        stepId: "s_click_search",
        action: "click",
        intent: "search for the member",
        riskLevel: "safe",
        locators: [{ kind: "role", role: "button", name: "Look Up Member", confidence: 0.9, rationale: "r" }],
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

  it("also overrides field labels templated off entity terminology (Member -> Customer), not just the button", () => {
    const override = generateLabelDriftOverride(capWithOpenSubAccountClick(), "tenant-b");
    expect(override.locatorOverrides["s_fill_member_id"]).toBeDefined();
    expect((override.locatorOverrides["s_fill_member_id"]![0] as any).label).toBe("Customer ID");
  });

  it("also overrides a role-based control name templated off entity terminology (Look Up Member -> Look Up Customer)", () => {
    const override = generateLabelDriftOverride(capWithOpenSubAccountClick(), "tenant-b");
    expect(override.locatorOverrides["s_click_search"]).toBeDefined();
    expect((override.locatorOverrides["s_click_search"]![0] as any).name).toBe("Look Up Customer");
  });
});
