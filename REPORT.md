# Design Report

## 1. Architecture

A single Node/TypeScript process, no services or queues — justified by scope (the brief explicitly penalizes building scaling infrastructure prematurely). Five modules with one clean seam each:

```
mock-app/         target surface: legacy-style credit union back office, 2 tenants
src/agent/        discovery — LLM-driven observe → decide → act loop (Groq)
src/artifact/     the Capability schema (Zod), storage, parameterization
src/surface/      Playwright driver: accessibility-tree observation, actions, locator resolution
src/replay/       deterministic replay executor + error taxonomy
src/safety/       allowlist enforcement, risk classification, redaction
src/escalation/   human-in-the-loop handoff (same live browser session)
src/capabilities/ agent-facing capability catalog + invoke-by-name
src/canon/        cross-tenant locator-override generation
src/cli/          discover | replay | invoke | list-capabilities | generate-override
```

**Key decision: the LLM never authors a selector.** `src/agent/tools.ts` exposes a semantic action vocabulary (`click(role, name)`, `fill(label, value)`, `extract_labeled_value(label, outputKey)`, ...) — the model expresses *intent*, and `src/surface/act.ts` is solely responsible for turning that into a ranked locator fallback chain. This keeps brittle, one-off selectors out of the model's hands entirely and means discovery and replay share the exact same locator-resolution code (`src/surface/locate.ts`) — there is no separate "replay reimplementation" of what discovery did.

**Key decision: observation is accessibility-tree text, not screenshots.** `src/surface/observe.ts` walks Playwright's accessibility snapshot into compact text (`- button "Log In"`, `- textbox "Member ID"`). This is what still works when a surface has no clean DOM (per Section 1's environment description) and it means the discovery LLM doesn't need vision. That's also the reason I could use Groq: Groq's hosted models are fast/cheap for the tool-calling decide-step but weaker on vision than Claude/GPT-4o computer-use — a real trade-off, not a free one. Its limit: a surface that's genuinely canvas-rendered or otherwise exposes no accessibility tree at all would defeat this approach entirely; that's the one class of legacy app this design doesn't reach (a screenshot+coordinates fallback would be the next increment, and the locator schema already has a `coordinates` variant reserved for it).

**Key decision: curation is a separate, explicit pass, not folded into discovery.** A single successful discovery run only ever walks the happy path. `src/artifact/parameterize.ts` rewrites literal values the model happened to type into `{{param}}` placeholders, and `src/replay/known-conditions.ts` attaches the business-outcome/interstitial patterns a human reviewer already knows about for this app family. In a real system this is a human-review step before a capability is promoted to production; here it's an explicit, auditable function call rather than something silently baked into the discovery loop.

## 2. Artifact schema

`src/artifact/schema.ts`, Zod-typed, `schemaVersion` + per-capability `version` for change tracking. A `Capability` is:

- **`steps[]`** — ordered actions (`navigate`/`click`/`fill`/`select`/`waitForText`/`extract`/`assertCheckpoint`), each with an `intent` (why, for a human reviewer) and a `riskLevel`.
- **Locator chains, not single selectors.** Every targeting field is `LocatorStrategy[]`, tried in order: `role` (ARIA role+name, confidence 0.9) → `label` (form-field `<label for>`) → `text` → `css`/`adjacentCell` (structural fallback for un-labeled data, e.g. a legacy label/value table row) → `coordinates` (last resort, reserved). Each entry carries a `confidence` and a `rationale` string — the "reasoning about robustness" the brief asks for is a first-class field, not prose in a comment.
- **Typed contract**: `inputParams` (name, type, required, `sensitive`) and `outputs` (name, type, which step produces it) — a capability is a function signature, not a transcript.
- **`successCheckpoint`** — the top-level proof the goal was reached.
- **`knownInterstitials`** and **`businessOutcomes`** — declared, recognizable mid-flow/terminal conditions specific to *this* flow (see §3). Generic, app-family-level conditions (session timeout, transient unavailability) are deliberately *not* here — they're not specific to any one business flow, so the replay engine checks for them directly rather than requiring every capability to redeclare them.
- **`sessionBootstrapStepCount`** — informational/reviewable metadata about which leading steps establish the session; see §3 for why the actual recovery mechanism doesn't rely on it alone.

Never stored: raw secrets. `sensitive: true` fill steps are recorded as `{{ParamName}}` templates at the moment they're captured (`src/surface/act.ts`), not redacted after the fact — there is no code path that ever writes a literal password into a step. `saveCapability` also runs every artifact through `redactDeep` before it touches disk, as a second, independent layer.

## 3. Determinism & error handling

Replay (`src/replay/executor.ts`) never calls the LLM. Before every step (and once more after the last step, since a condition can just as easily be produced *by* the final step — e.g. a large-deposit confirmation interstitial that only appears after submit), it checks the current page against the capability's declared conditions, in this order:

1. **Business outcome** (`record_not_found`, `permission_denied`, `validation_error`) → stop, return `{status:"business_outcome", code, detail}`. Not a crash, not a retry — a legitimate answer the caller needs.
2. **Known interstitial** (e.g. the large-deposit confirmation) → auto-dismiss via its declared `dismissAction`, log a recovery event, keep going.
3. **Session expired** (generic marker, engine-level) → re-authenticate **and replay every step before the current one**, not just a recorded "login prefix." I initially implemented the narrower version (re-run only a fixed `sessionBootstrapStepCount` prefix) and found, while testing it against a deliberately-expired session mid-flow, that it left replay stranded on the wrong page whenever expiry was detected past the first few steps — re-authenticating gets you logged in, but not back to where step *i* expects to be. Replaying every prior step is the general fix; it's safe here because every pre-extract step in this flow is idempotent (search/read), and that assumption is called out explicitly in §7 as a limitation for flows whose early steps mutate state.
4. **Transient unavailability** (generic marker) → bounded wait-and-retry (3 attempts, backoff).
5. **Unrecognized state** (raw server error, or nothing matches) → **hard failure**: stop, screenshot, and report exactly which step, what was expected, what was observed.

A locator chain that fails to resolve at all (`resolveLocatorChain` exhausts every strategy) is also a hard failure with the same structured detail — this is the "sound checkpoint strategy" the evaluation criteria calls out: replay never silently proceeds on an assumption.

Risky steps (anything classified as mutating — `fill`/`select` by default, configurable in `allowlist.config.json`) are gated: the first risky step in a run pauses for human confirmation via the same escalation mechanism as §5, unless the caller explicitly opts into `riskyStepPolicy: "auto"` (used by the agent-facing `invoke` path and CI).

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is `src/surface/act.ts` (write) and `observe.ts`/`locate.ts` (read): both operate purely in terms of accessibility roles, labels, and text — never raw coordinates or DOM structure as the *primary* strategy. Extending to a legacy web app with worse markup mostly costs locator-chain confidence, not new code: the `css`/`adjacentCell`/XPath fallback tiers already exist for exactly that case (see the extract-value locator, built for a two-column label/value table with no test IDs). Extending to a **desktop app** would mean swapping `src/surface/*` for an OS-accessibility-API driver (Windows UI Automation / macOS Accessibility) behind the same three verbs (`observe`, `act`, `resolveLocatorChain`) — the `Capability` schema itself is already surface-agnostic; nothing in it assumes a browser. That's the deliberate boundary: **the artifact format doesn't know what kind of surface recorded it.**

**Multi-tenant reuse**, demonstrated, not just described: `tenant-a` and `tenant-b` in `mock-app/` are the same underlying app with different branding, terminology, and one deliberately drifted control label (`"Open Sub-Account"` vs `"Create New Sub-Account"`). `src/canon/override.ts` generates a `TenantOverride` — a per-step locator chain to try *first*, with the base capability's original chain kept as fallback — so a capability recorded on tenant-a keeps working unmodified on any tenant that *didn't* rename the control, and gets a minimal, targeted specialization for the one that did. `src/artifact/parameterize.ts` also folds the tenant slug itself into a `{{baseTenant}}` template parameter, so the same artifact file drives either tenant; only the override is tenant-specific.

This is intentionally a small, explainable heuristic (compare known per-tenant config for the same control) rather than a generic UI-diffing engine. At real scale (hundreds of tenants, ~20 apps each), the natural extension is: (a) an artifact carries a `vendorProductId` instead of being keyed to one tenant, (b) overrides are stored and versioned per `(vendorProductId, tenantId)` pair and applied the same way, (c) replay failures against a specific tenant are the drift-detection signal — a capability that starts hard-failing on one tenant but not others is exactly the "per-tenant/version drift" the brief asks about, and the structured `hard_failure` result (which step, expected vs. observed) is already the right shape to route into an "override needed" queue rather than a full re-recording.

## 5. Escalation & handoff

`src/escalation/handoff.ts`, shared by both discovery (`request_human`, repeated failures, step-budget exceeded) and replay (an unrecoverable condition, or a risky step pending confirmation).

The browser runs **headful** by design — not a implementation shortcut but the actual mechanism: when automation cedes control, the human takes the real mouse/keyboard on the *same* visible Chrome window, the *same* Playwright `page`/browser process, not a fresh session and not a screenshot relay. Control ownership is tracked explicitly (`controlState: "agent" | "human"` on the written `InterventionRequest`), and — critically — automation genuinely stops issuing Playwright commands for the duration (a blocking `await` on the operator's signal), so "a human is in control" is a real guarantee, not a race condition two processes could both act into. Before/after screenshots and the operator's notes are captured to the same evidence directory as the run that triggered the escalation, so context isn't lost across the handoff.

**Scope cut, stated up front (the brief explicitly allows this):** the operator "console" is the terminal prompt plus the visible browser window, not a remote co-browsing UI. The documented extension is `chromium.launchServer()` + a second process attaching via `chromium.connect(wsEndpoint)`, so a remote (not co-located) operator could attach to the same live session without needing physical access to the machine running automation — not implemented, but the current mechanism's control-transfer *model* (explicit ownership state, pause/resume on the same session) doesn't change if the transport does.

## 6. Safety

`src/safety/allowlist.config.json` is the explicit, editable policy: permitted origins, permitted action types, which action types count as risky, and a max-steps bound. Enforced at the point of action (`assertOriginAllowed`/`assertActionTypeAllowed` in `src/surface/act.ts` and the replay executor) — not just checked once at startup, so a discovery run cannot be redirected mid-flow to an origin outside policy.

Risk is binary and conservative by default: any state-mutating action type (`fill`, `select`, configurable) is `risky`; reads and navigation are `safe`. Risky steps gate through human confirmation unless a caller explicitly opts into unattended mode. This is coarser than a real system would eventually want (e.g. distinguishing "fill a search box" from "fill a wire-transfer amount" — both are technically `fill`), and that's a named limitation, not an oversight: the schema's `riskLevel` field is per-step, so a finer-grained classifier (e.g. keyed off which *field* is being filled, or a business-outcome-value threshold) is a natural next increment without changing the schema.

Redaction is defense-in-depth, not a single control: (1) sensitive values are never written as literals into a step in the first place — a `sensitive: true` fill is recorded as a `{{param}}` template at capture time; (2) `saveCapability` runs every artifact through a deep redactor before it touches disk; (3) the structured logger (`src/logging/logger.ts`) redacts every record it writes, so a bug in one layer doesn't leak through the other two. The redactor pattern-matches common secret/PII shapes (SSN, card-number-like digit runs, email, bearer tokens, API-key-like strings) and additionally strips any value under a sensitive-sounding key name outright.

## 7. Cuts

- **Only one concrete surface implemented** (the mock web app), as the brief allows — the desktop/legacy-web story in §4 is design-only.
- **No multi-tenant plumbing beyond two tenants**, and cross-tenant override generation is a small, explainable heuristic rather than a general drift-detector — flagged, not hidden.
- **Session-timeout recovery replays all prior steps**, which is only safe because this flow's pre-failure steps are idempotent. A capability with an early non-idempotent step (e.g., a transfer before a lookup) would need step-level idempotency markers before this recovery strategy could apply safely; not implemented.
- **Risk classification is per action-type, not per-field or per-value.** A finer-grained policy (e.g., dollar-amount thresholds) is the natural next increment.
- **The operator console is a terminal prompt over a local headful browser, not a remote co-browsing UI** — the remote-attach extension is documented (§5) but not built.
- **No confidence/approval scoring, no multi-run stability signal, no LLM-assisted single-step replay fallback** — of the optional stretch goals, I built two (agent-facing capability interface; cross-tenant reuse with a real second tenant and a generated override) rather than a shallow pass at several, per the brief's explicit "depth over breadth" guidance.

What I'd build next, in order: (1) a per-field/value risk classifier, since it's the highest-leverage safety improvement and the schema already supports it; (2) the remote operator-console transport, since the control-transfer model is already real and this is "just" swapping how a human physically attaches; (3) a third tenant with genuine schema drift (not just label drift) to stress-test the override model past what a locator-chain fallback alone can absorb.
