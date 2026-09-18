import type { BusinessOutcomePattern, KnownInterstitial } from "../artifact/schema.js";

/**
 * A single successful discovery run only ever walks the happy path — it
 * won't spontaneously encounter "member not found" or "permission denied."
 * In a real system, a human reviewer curates the raw discovered artifact
 * before promoting it to a production capability, annotating the
 * known-but-not-walked business outcomes and interstitials for that app
 * family. This function is that curation step, made explicit and reusable
 * per tenant (since wording — "member" vs "customer" — differs).
 */
export function curateKnownConditions(entityLabel: string): {
  businessOutcomes: BusinessOutcomePattern[];
  knownInterstitials: KnownInterstitial[];
} {
  const lower = entityLabel.toLowerCase();
  return {
    businessOutcomes: [
      {
        code: "record_not_found",
        description: `No ${lower} exists for the given ID — a legitimate lookup result, not a system failure.`,
        matchCheckpoint: { kind: "textPresent", text: `No ${lower} found with ID` },
      },
      {
        code: "permission_denied",
        description: `The operator does not have permission to view this ${lower}'s record.`,
        matchCheckpoint: { kind: "textPresent", text: "do not have permission to view" },
      },
      {
        code: "validation_error",
        description: "The submitted input failed server-side validation (e.g. deposit below minimum).",
        matchCheckpoint: { kind: "textPresent", text: "must be a number of at least $25" },
      },
    ],
    knownInterstitials: [
      {
        id: "large_deposit_confirmation",
        description: "Deposits above the standard threshold require an extra confirmation step not on the recorded happy path.",
        matchCheckpoint: { kind: "textPresent", text: "exceeds the standard threshold" },
        dismissAction: {
          action: "click",
          locators: [{ kind: "role", role: "button", name: "Confirm", confidence: 0.9, rationale: "Confirmation interstitial exposes a single unambiguous Confirm button." }],
        },
      },
    ],
  };
}

// Generic, app-family-level runtime conditions (session/transient/hard
// error) are NOT part of the artifact — they're not specific to any one
// business flow, so the replay engine checks for them after every step
// rather than requiring every capability author to redeclare them.
export const SESSION_EXPIRED_MARKER = "session has expired";
export const TRANSIENT_UNAVAILABLE_MARKER = "System temporarily unavailable";
export const HARD_SERVER_ERROR_MARKER = "Internal Server Error";
