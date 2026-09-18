import { describe, expect, it } from "vitest";
import { redactDeep, redactString, isSensitiveFieldName } from "../src/safety/redact.js";

describe("redact", () => {
  it("redacts SSN-like and email-like patterns in strings", () => {
    expect(redactString("ssn is 123-45-6789")).toBe("ssn is [REDACTED]");
    expect(redactString("contact jane@example.com")).toBe("contact [REDACTED]");
  });

  it("redacts bearer tokens and api-key-like strings", () => {
    expect(redactString("Authorization: Bearer abcdefghijklmnop123")).toContain("[REDACTED]");
    expect(redactString("key=sk_live_abcdefghijklmnop")).toContain("[REDACTED]");
  });

  it("drops values for sensitive field names in deep objects", () => {
    const out = redactDeep({ password: "hunter2", memberId: "12345", nested: { token: "abc123xyz" } });
    expect(out.password).toBe("[REDACTED]");
    expect(out.nested.token).toBe("[REDACTED]");
    expect(out.memberId).toBe("12345");
  });

  it("recognizes sensitive field names regardless of casing/separators", () => {
    expect(isSensitiveFieldName("API_KEY")).toBe(true);
    expect(isSensitiveFieldName("Credit-Card")).toBe(true);
    expect(isSensitiveFieldName("memberId")).toBe(false);
  });
});
