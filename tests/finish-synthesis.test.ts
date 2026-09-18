import { describe, expect, it } from "vitest";
import { trySynthesizeFinishFromFailedGeneration } from "../src/agent/loop.js";

// Regression: observed live against Groq — a successful discovery run's
// final `finish` call was rejected with 400 tool_use_failed because the
// model emitted well-formed finish arguments as raw content instead of a
// proper tool call. Recovering this narrowly (only when the rejected
// content parses as JSON with `successCheckpointText`) saves an otherwise-
// complete run from being lost to an API-level formatting quirk.
describe("trySynthesizeFinishFromFailedGeneration", () => {
  it("synthesizes a finish tool call from a rejected generation with successCheckpointText", () => {
    const err = {
      error: {
        error: {
          code: "tool_use_failed",
          failed_generation: JSON.stringify({
            summary: "done",
            successCheckpointText: "Sub-account created successfully",
            outputs: { savings_balance: "$4820.55" },
          }),
        },
      },
    };
    const result = trySynthesizeFinishFromFailedGeneration(err);
    expect(result).not.toBeNull();
    const toolCall = result.choices[0].message.tool_calls[0];
    expect(toolCall.function.name).toBe("finish");
    const args = JSON.parse(toolCall.function.arguments);
    expect(args.successCheckpointText).toBe("Sub-account created successfully");
  });

  it("returns null for a differently-coded error (does not swallow unrelated failures)", () => {
    const err = { error: { error: { code: "invalid_api_key", failed_generation: "{}" } } };
    expect(trySynthesizeFinishFromFailedGeneration(err)).toBeNull();
  });

  it("returns null when the failed generation doesn't look like a finish call", () => {
    const err = {
      error: { error: { code: "tool_use_failed", failed_generation: JSON.stringify({ role: "button", name: "Submit" }) } },
    };
    expect(trySynthesizeFinishFromFailedGeneration(err)).toBeNull();
  });

  it("returns null when failed_generation isn't valid JSON", () => {
    const err = { error: { error: { code: "tool_use_failed", failed_generation: "not json {" } } };
    expect(trySynthesizeFinishFromFailedGeneration(err)).toBeNull();
  });
});
