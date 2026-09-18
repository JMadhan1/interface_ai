# Evidence

All of this is from real runs against the local mock app — no fabricated logs. `artifacts/cap_fo6Vf548DW.v1.json` is the capability these runs all exercise.

## 1. Discovery (the real, required LLM-driven run)

**`discover_ELxVR2GJ/console-output.txt`** — a genuine discovery run: Groq (`openai/gpt-oss-20b`) driving a live Chrome window through login → member lookup → savings-balance extraction → sub-account creation → confirmation, with no scripted steps. Two things worth pointing out in this exact log, because they're why the capability looks the way it does:

- The model tried an initial deposit of `00` first (a `$500` in the goal text got mangled to `00` by a shell quoting mistake on my part — `"$500"` inside a double-quoted Bash string), hit this app's real server-side validation error, and self-corrected to `25` on its own. That's genuine runtime-error handling happening during discovery, not scripted.
- Search `dropped_unbacked_outputs` in this log: the model declared `newAccountId` as an output in its `finish` call without ever calling `extract_labeled_value` for it. I caught this reviewing the raw artifact (see `REPORT.md` §1) and fixed the discovery loop to drop self-reported-but-unbacked outputs rather than silently promising something replay could never produce, then added a real extract step for it during curation (the same kind of human review pass `curateKnownConditions` already does for business outcomes).

The saved capability's `sessionBootstrapStepCount`, `knownInterstitials`, and `businessOutcomes` were attached during that same curation pass — a single happy-path run can't discover "member not found" on its own; see `REPORT.md` §2–3.

*(The structured `log.jsonl` for this specific run was lost to a filesystem race — a second, independent discovery process was running against the same working directory at the same time and its own cleanup step deleted `evidence/` out from under this one. `console-output.txt` is the complete raw console capture of the same run, redirected to a file as it happened, and is unedited.)*

## 2. Replay — success path

**`replay_E1PP4WvX/`** — deterministic replay of the capability above, no LLM involved: `memberId=12345` → `savingsBalance: "$4820.55"`, `newAccountId: "SA-KCVJDN"`. Includes the escalation record for the risky-step confirmation gate (`intervention_*.request.json` / `.resolution.json` / before+after screenshots) — replay paused before the first mutating step and required approval before continuing.

## 3. Replay — error / business outcome

**`replay_J0PYnagi/`** — same capability, `memberId=00000`: stops with `{status:"business_outcome", code:"record_not_found"}` after the search step, not a crash. This is the brief's specific ask — a run that hits an exceptional state and reports it as a legitimate result.

## 4. Cross-tenant reuse — including two real failures on the way to it

This is the honest version of "generalizes across tenants," not a cherry-picked success:

- **`replay_GpuGkQpc/`** — first attempt against `tenant-b` with an override that only covered the one button-label drift I'd anticipated (`generate-override`). Hard-failed immediately at the next field ("Member ID" vs tenant-b's "Customer ID") — screenshot included.
- **`replay_Kkiy7Nc_/`** — second attempt after fixing that; hard-failed again at the search button ("Look Up Member" vs "Look Up Customer") — same root cause (entity terminology), different control.
- **`replay_jVObuHzD/`** — after generalizing `generateLabelDriftOverride` to check every locator carrying text for the entity-word drift (not just the one control I'd first noticed), the full flow succeeds against `tenant-b`: `savingsBalance: "$3110.40"` (Dana Whitfield's real tenant-b balance, distinct from Jordan Ellis's tenant-a data), `newAccountId: "SA-S9RCH8"`.

The override actually used for the successful run is `artifacts/overrides/cap_fo6Vf548DW.tenant-b.json`. See `REPORT.md` §4 for the design discussion of why this is a small, explainable heuristic rather than a generic UI-diffing engine.

## 5. Multi-run stability signal

**`stability_cap_fo6Vf548DW_1789718211000/stability-report.json`** — the same capability replayed 5 independent times (`npm run stability-check`), headless, unattended (`riskyStepPolicy: "auto"`): 5/5 success, `allIdentical: true`. Per-run duration genuinely varies (1.4s–24.8s — the first run pays Chrome's cold-start cost, the rest don't), which is exactly the kind of real signal a single anecdotal run can't show. This is one real data point, not a claim that the capability is bulletproof — the report format is the artifact; running it against more param combinations and over more time is what would build a real confidence signal (see `REPORT.md` §4, "Detecting drift at scale").
