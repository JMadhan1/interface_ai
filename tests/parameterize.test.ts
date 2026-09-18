import { describe, expect, it } from "vitest";
import { parameterize } from "../src/artifact/parameterize.js";
import type { Capability } from "../src/artifact/schema.js";

function cap(): Capability {
  return {
    schemaVersion: "1.0",
    id: "cap_1",
    name: "Look up member",
    description: "test",
    version: 1,
    provenance: {
      goal: "look up member 12345",
      targetBaseUrl: "http://localhost:4100/tenant-a",
      baseTenant: "tenant-a",
      model: "m",
      discoveryRunId: "d1",
      discoveredAt: new Date().toISOString(),
    },
    inputParams: [],
    steps: [
      { stepId: "s1", action: "navigate", url: "http://localhost:4100/tenant-a/login", intent: "go", riskLevel: "safe" },
      {
        stepId: "s2",
        action: "fill",
        locators: [{ kind: "label", label: "Member ID", confidence: 0.9, rationale: "r" }],
        value: "12345",
        intent: "type member id",
        riskLevel: "risky",
        sensitive: false,
      },
    ],
    sessionBootstrapStepCount: 0,
    knownInterstitials: [],
    businessOutcomes: [],
    outputs: [],
    successCheckpoint: { kind: "textPresent", text: "done" },
  };
}

describe("parameterize", () => {
  it("rewrites matching literal values to template placeholders and registers the input param", () => {
    const result = parameterize(cap(), [
      { name: "memberId", type: "string", required: true, description: "member id", sensitive: false, literalValue: "12345" },
      { name: "baseTenant", type: "string", required: true, description: "tenant", sensitive: false, literalValue: "tenant-a" },
    ]);

    const fillStep = result.steps.find((s) => s.action === "fill");
    expect((fillStep as any).value).toBe("{{memberId}}");

    const navStep = result.steps.find((s) => s.action === "navigate");
    expect((navStep as any).url).toBe("http://localhost:4100/{{baseTenant}}/login");

    expect(result.inputParams.map((p) => p.name)).toEqual(expect.arrayContaining(["memberId", "baseTenant"]));
  });

  it("leaves non-matching literals untouched", () => {
    const result = parameterize(cap(), [{ name: "somethingElse", type: "string", required: true, description: "x", sensitive: false, literalValue: "nope-not-present" }]);
    const fillStep = result.steps.find((s) => s.action === "fill");
    expect((fillStep as any).value).toBe("12345");
  });
});
