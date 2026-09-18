import { describe, expect, it } from "vitest";
import { toParamName } from "../src/surface/act.js";

describe("toParamName", () => {
  it("lowercases only the first character and strips spaces, matching CLI-declared credential param names", () => {
    expect(toParamName("Username")).toBe("username");
    expect(toParamName("Password")).toBe("password");
  });

  it("strips internal whitespace for multi-word labels", () => {
    expect(toParamName("Member ID")).toBe("memberID");
  });

  // Regression: a sensitive fill's recorded {{template}} name must match the
  // name the discover CLI declares in inputParams, or every replay of the
  // capability fails with "missing required param" against a param that
  // does exist under a differently-cased key. Caught during live discovery
  // testing (label "Password" produced {{Password}} while the CLI declared
  // "password").
  it("produces a name consistent regardless of how the label happens to be cased", () => {
    expect(toParamName("PIN")).toBe("pIN");
    expect(toParamName("pin")).toBe("pin");
  });
});
