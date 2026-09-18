import { z } from "zod";

// ---------------------------------------------------------------------------
// Locator strategy: a fallback chain, not a single selector. Each entry is
// tagged with a confidence and the reasoning for why it should (or shouldn't)
// survive a UI that has no clean DOM. Replay tries them in order.
// ---------------------------------------------------------------------------

export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role"),
    role: z.string(), // ARIA role, e.g. "button", "textbox", "link"
    name: z.string(), // accessible name
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
  z.object({
    kind: z.literal("label"),
    label: z.string(), // associated <label for> text — robust for form fields
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    exact: z.boolean().default(true),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
  z.object({
    kind: z.literal("css"),
    selector: z.string(), // escape hatch; lowest confidence by convention
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
  z.object({
    // Label/value table-row pattern common in legacy server-rendered admin
    // screens: find the exact-text label node, walk to its closest
    // ancestor <tr>, then read the Nth direct <td> child of that row. Scoped
    // via `ancestor::tr[1]` so it can't accidentally match an outer wrapper
    // row that merely contains the label text somewhere in its subtree.
    kind: z.literal("adjacentCell"),
    rowLabelText: z.string(),
    cellIndex: z.number().int().min(1), // 1-based, matches XPath position()
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
  z.object({
    kind: z.literal("coordinates"),
    x: z.number(),
    y: z.number(),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const LocatorChainSchema = z.array(LocatorStrategySchema).min(1);
export type LocatorChain = z.infer<typeof LocatorChainSchema>;

// ---------------------------------------------------------------------------
// Checkpoints: how a step (or the whole capability) proves it actually
// reached the state it expected, rather than assuming the click worked.
// ---------------------------------------------------------------------------

export const CheckpointConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("textPresent"), text: z.string() }),
  z.object({ kind: z.literal("textAbsent"), text: z.string() }),
  z.object({ kind: z.literal("urlMatches"), pattern: z.string() }),
  z.object({ kind: z.literal("elementVisible"), locators: LocatorChainSchema }),
]);
export type CheckpointCondition = z.infer<typeof CheckpointConditionSchema>;

// ---------------------------------------------------------------------------
// Risk classification. Drives whether replay may proceed unattended.
// ---------------------------------------------------------------------------

export const RiskLevelSchema = z.enum(["safe", "risky"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

// ---------------------------------------------------------------------------
// Steps: the ordered, replayable actions. `{{paramName}}` in string fields is
// a template placeholder resolved from typed input params at replay time.
// ---------------------------------------------------------------------------

const StepBase = {
  stepId: z.string(),
  intent: z.string(), // human-readable "why" — what a reviewer reads
  riskLevel: RiskLevelSchema,
};

export const ActionStepSchema = z.discriminatedUnion("action", [
  z.object({ ...StepBase, action: z.literal("navigate"), url: z.string() }),
  z.object({ ...StepBase, action: z.literal("click"), locators: LocatorChainSchema }),
  z.object({
    ...StepBase,
    action: z.literal("fill"),
    locators: LocatorChainSchema,
    value: z.string(), // template, e.g. "{{memberId}}"
    sensitive: z.boolean().default(false),
  }),
  z.object({ ...StepBase, action: z.literal("select"), locators: LocatorChainSchema, value: z.string() }),
  z.object({ ...StepBase, action: z.literal("waitForText"), text: z.string(), timeoutMs: z.number().default(5000) }),
  z.object({
    ...StepBase,
    action: z.literal("extract"),
    locators: LocatorChainSchema,
    outputKey: z.string(),
    extractAs: z.enum(["text", "number"]).default("text"),
  }),
  z.object({ ...StepBase, action: z.literal("assertCheckpoint"), condition: CheckpointConditionSchema }),
]);
export type ActionStep = z.infer<typeof ActionStepSchema>;

// ---------------------------------------------------------------------------
// Known interstitials: conditions the *recorder* already knows can appear at
// replay time even though they weren't on the recorded happy path (e.g. a
// large-deposit confirmation dialog triggered only for certain param values).
// This is how "dismiss a known interstitial" (a recoverable condition, per
// the brief) becomes part of the capability's own contract instead of a
// hidden side-channel in the replay engine.
// ---------------------------------------------------------------------------

export const KnownInterstitialSchema = z.object({
  id: z.string(),
  description: z.string(),
  matchCheckpoint: CheckpointConditionSchema, // how replay recognizes it mid-flow
  dismissAction: z.object({
    action: z.enum(["click"]),
    locators: LocatorChainSchema,
  }),
});
export type KnownInterstitial = z.infer<typeof KnownInterstitialSchema>;

// ---------------------------------------------------------------------------
// Known business outcomes: legitimate, non-success terminal results the
// caller needs to know about (e.g. "no such member") — the distinction the
// brief calls the most common design mistake to get wrong. These are
// terminal (unlike interstitials, which are dismissed and the flow
// continues); replay stops and reports the code, not a crash.
// ---------------------------------------------------------------------------

export const BusinessOutcomePatternSchema = z.object({
  code: z.string(),
  description: z.string(),
  matchCheckpoint: CheckpointConditionSchema,
});
export type BusinessOutcomePattern = z.infer<typeof BusinessOutcomePatternSchema>;

// ---------------------------------------------------------------------------
// Typed contract: what the agent supplies, and what it gets back.
// ---------------------------------------------------------------------------

export const InputParamSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean(),
  description: z.string(),
  sensitive: z.boolean().default(false),
});
export type InputParam = z.infer<typeof InputParamSchema>;

export const OutputSpecSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  sourceStepId: z.string(), // which extract step produces this
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

// ---------------------------------------------------------------------------
// The capability artifact itself.
// ---------------------------------------------------------------------------

export const ProvenanceSchema = z.object({
  goal: z.string(),
  targetBaseUrl: z.string(),
  baseTenant: z.string(), // the tenant this was originally discovered against
  model: z.string(),
  discoveryRunId: z.string(),
  discoveredAt: z.string(), // ISO timestamp
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const CapabilitySchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number().int().min(1),
  provenance: ProvenanceSchema,
  inputParams: z.array(InputParamSchema),
  steps: z.array(ActionStepSchema).min(1),
  /** How many leading steps establish the session (login) — informational/reviewable metadata. Session-timeout recovery re-walks all prior steps, not just this prefix (see REPORT.md, Determinism & error handling). */
  sessionBootstrapStepCount: z.number().int().min(0).default(0),
  knownInterstitials: z.array(KnownInterstitialSchema).default([]),
  businessOutcomes: z.array(BusinessOutcomePatternSchema).default([]),
  outputs: z.array(OutputSpecSchema),
  successCheckpoint: CheckpointConditionSchema,
});
export type Capability = z.infer<typeof CapabilitySchema>;

// ---------------------------------------------------------------------------
// Tenant override: how a capability recorded on a "base" tenant is safely
// specialized for another tenant running the same underlying vendor product,
// without re-recording. Applied on top of a Capability at replay time.
// ---------------------------------------------------------------------------

export const TenantOverrideSchema = z.object({
  forTenant: z.string(),
  baseCapabilityId: z.string(),
  baseCapabilityVersion: z.number().int(),
  reason: z.string(),
  // stepId -> replacement locator chain to try before the base chain
  locatorOverrides: z.record(z.string(), LocatorChainSchema).default({}),
});
export type TenantOverride = z.infer<typeof TenantOverrideSchema>;
