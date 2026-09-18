import { describe, expect, it } from "vitest";
import { InterventionRequestSchema, InterventionResolutionSchema } from "../src/escalation/handoff.js";

describe("remote-operator intervention schema", () => {
  it("accepts a local intervention request with no cdpEndpoint", () => {
    const parsed = InterventionRequestSchema.parse({
      id: "intervention_1",
      raisedAt: new Date().toISOString(),
      goal: "test",
      reason: "test",
      pageUrl: "http://localhost:4100/tenant-a/login",
      screenshotPath: "evidence/x.png",
      controlState: "human",
    });
    expect(parsed.cdpEndpoint).toBeUndefined();
  });

  it("accepts a remote-operator request carrying a cdpEndpoint", () => {
    const parsed = InterventionRequestSchema.parse({
      id: "intervention_2",
      raisedAt: new Date().toISOString(),
      goal: "test",
      reason: "test",
      pageUrl: "http://localhost:4100/tenant-a/login",
      screenshotPath: "evidence/x.png",
      controlState: "human",
      cdpEndpoint: "http://localhost:44644",
    });
    expect(parsed.cdpEndpoint).toBe("http://localhost:44644");
  });

  it("validates a resolution written by a separate operator-attach process", () => {
    const parsed = InterventionResolutionSchema.parse({
      interventionId: "intervention_2",
      resumedAt: new Date().toISOString(),
      operatorNotes: "verified same session, resumed",
      resultingUrl: "http://localhost:4100/tenant-a/login",
    });
    expect(parsed.operatorNotes).toContain("resumed");
  });
});
