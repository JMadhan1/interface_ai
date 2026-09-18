import { describe, expect, it } from "vitest";
import { CapabilitySchema } from "../src/artifact/schema.js";

function baseCapability() {
  return {
    schemaVersion: "1.0" as const,
    id: "cap_test123",
    name: "Test capability",
    description: "A test capability",
    version: 1,
    provenance: {
      goal: "test goal",
      targetBaseUrl: "http://localhost:4100/tenant-a",
      baseTenant: "tenant-a",
      model: "llama-3.3-70b-versatile",
      discoveryRunId: "discover_abc",
      discoveredAt: new Date().toISOString(),
    },
    inputParams: [{ name: "memberId", type: "string" as const, required: true, description: "member id", sensitive: false }],
    steps: [
      {
        stepId: "step_1",
        action: "navigate" as const,
        url: "http://localhost:4100/tenant-a/login",
        intent: "go to login",
        riskLevel: "safe" as const,
      },
      {
        stepId: "step_2",
        action: "click" as const,
        intent: "click submit",
        riskLevel: "safe" as const,
        locators: [{ kind: "role" as const, role: "button", name: "Submit", confidence: 0.9, rationale: "primary" }],
      },
    ],
    sessionBootstrapStepCount: 0,
    knownInterstitials: [],
    businessOutcomes: [],
    outputs: [],
    successCheckpoint: { kind: "textPresent" as const, text: "done" },
  };
}

describe("CapabilitySchema", () => {
  it("parses a well-formed capability", () => {
    const parsed = CapabilitySchema.parse(baseCapability());
    expect(parsed.id).toBe("cap_test123");
    expect(parsed.steps).toHaveLength(2);
  });

  it("rejects a capability with zero steps", () => {
    const bad = { ...baseCapability(), steps: [] };
    expect(() => CapabilitySchema.parse(bad)).toThrow();
  });

  it("rejects an out-of-range locator confidence", () => {
    const bad = baseCapability();
    (bad.steps[1] as any).locators[0].confidence = 1.5;
    expect(() => CapabilitySchema.parse(bad)).toThrow();
  });

  it("rejects an unknown action discriminant", () => {
    const bad = baseCapability();
    (bad.steps[0] as any).action = "teleport";
    expect(() => CapabilitySchema.parse(bad)).toThrow();
  });
});
