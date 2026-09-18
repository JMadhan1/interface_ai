import { describe, expect, it } from "vitest";
import { assertActionTypeAllowed, assertOriginAllowed, classifyRisk, DEFAULT_ALLOWLIST, PolicyViolation } from "../src/safety/allowlist.js";

describe("allowlist enforcement", () => {
  it("allows an origin present in the config", () => {
    expect(() => assertOriginAllowed("http://localhost:4100/tenant-a/login", DEFAULT_ALLOWLIST)).not.toThrow();
  });

  it("rejects an origin not in the config", () => {
    expect(() => assertOriginAllowed("https://evil.example.com/steal", DEFAULT_ALLOWLIST)).toThrow(PolicyViolation);
  });

  it("rejects an action type not in the config", () => {
    expect(() => assertActionTypeAllowed("delete_everything", DEFAULT_ALLOWLIST)).toThrow(PolicyViolation);
  });

  it("classifies mutating actions as risky and reads as safe", () => {
    expect(classifyRisk("fill")).toBe("risky");
    expect(classifyRisk("select")).toBe("risky");
    expect(classifyRisk("click")).toBe("safe");
    expect(classifyRisk("navigate")).toBe("safe");
    expect(classifyRisk("extract")).toBe("safe");
  });
});
