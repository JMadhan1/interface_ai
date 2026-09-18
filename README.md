# Computer-Use Automation System

[![CI](https://github.com/JMadhan1/interface_ai/actions/workflows/ci.yml/badge.svg)](https://github.com/JMadhan1/interface_ai/actions/workflows/ci.yml)

A discover-once, replay-many automation system for legacy back-office UIs that have no API: an LLM figures out a task once against a live surface, that run is recorded as a typed, versioned **capability**, and the capability then replays deterministically — no model in the loop — with a real error taxonomy and a human-escalation path for anything it can't safely handle alone.

![Architecture](./docs/architecture.svg)

See [REPORT.md](./REPORT.md) for the full design write-up (architecture, artifact schema, error handling, heterogeneity/multi-tenant story, escalation, safety, and cuts).

## Requirements

- Node.js 20+
- A [Groq](https://console.groq.com/) API key (discovery uses Groq's OpenAI-compatible tool-calling API — see `REPORT.md` for why Groq)
- Google Chrome installed (the surface driver uses your system Chrome via Playwright's `channel: "chrome"` by default, so no ~300MB browser download is required). If you'd rather use Playwright's bundled Chromium, run `npx playwright install chromium` and set `PLAYWRIGHT_CHANNEL=chromium`.

## Setup

```bash
npm install
cp .env.example .env   # then fill in GROQ_API_KEY
```

No other services are required — the target application is a local mock app included in this repo (`mock-app/`), so the whole system runs without any external dependency except the Groq API call made during discovery.

## Running without live services

Everything except the one live discovery run works fully offline:

- `npm test` — unit tests (schema validation, parameterization, redaction, allowlist enforcement, cross-tenant override generation). No browser or network required.
- `npm run replay` — deterministic replay against the local mock app. No LLM/network call at all; this is the production execution path.
- `npm run invoke` — the agent-facing capability interface, same guarantee.

Only `npm run discover` calls out to Groq.

## Demo path

**1. Start the mock target application** (a legacy-style credit union back office, two tenants, in a separate terminal):

```bash
npm run mock-app
```

This serves `http://localhost:4100`, with tenants `tenant-a` (Meridian Credit Union) and `tenant-b` (Harborline Financial) — the same underlying app, different branding, one deliberately drifted button label, and an extra schema column on tenant-b. Login for both: `operator` / `operator123`.

**2. Run discovery** (drives a real, visible Chrome window with an LLM deciding each action):

```bash
GROQ_API_KEY=your_key npm run discover -- \
  --goal 'Log in with username operator and password operator123. Then look up member 12345, read their savings balance, then open a Holiday Club sub-account for them with a 500 dollar initial deposit and reach the confirmation screen showing the new account ID.' \
  --tenant tenant-a \
  --model openai/gpt-oss-20b \
  --param memberId=12345 \
  --param accountType="Holiday Club" \
  --param depositAmount=500
```

Use single quotes around `--goal` as shown (not double quotes) — a `$` followed by digits inside a double-quoted string is parsed by the shell as a positional parameter and silently stripped, which is exactly what happened while building this: `"$500"` became `"00"` in one run (see `evidence/README.md`). `--model openai/gpt-oss-20b` is a deliberate recommendation, not just an example: this account's available model list turned out not to include the usual Llama models, and the much larger default (`openai/gpt-oss-120b`) hit Groq's on-demand-tier quota repeatedly during development — see Troubleshooting below.

This prints the saved artifact path, e.g. `artifacts/cap_xxxxxxxxxx.v1.json`, and writes a step-by-step log to `evidence/discover_.../`. **What the model actually does — which literal values it uses, whether it self-corrects out of a validation error, whether it extracts every value you'd want as an output — varies run to run and isn't fully scripted by the goal text.** `evidence/README.md` documents exactly what happened on the real run behind the capability already included in this repo (`cap_fo6Vf548DW`), including two real bugs it surfaced and how they were fixed, as a concrete worked example you can inspect without spending your own Groq quota.

**3. Replay the resulting artifact deterministically** (no LLM involved) — using the included real capability:

```bash
npm run mock-app   # if not already running

npm run replay -- \
  --capability cap_fo6Vf548DW \
  --param username=operator --param password=operator123 \
  --param memberId=12345
```

Try it against a condition the capability wasn't literally recorded on, to see the error taxonomy in action:

```bash
# a record that doesn't exist — a legitimate business outcome, not a crash
npm run replay -- --capability cap_fo6Vf548DW --param username=operator --param password=operator123 --param memberId=00000
```

**4. Invoke it the way an AI agent would** (the agent-facing capability interface — a thin wrapper over the same replay engine):

```bash
npm run list-capabilities
npm run invoke -- --capability cap_fo6Vf548DW --param username=operator --param password=operator123 --param memberId=12345
```

**5. Cross-tenant reuse** (stretch goal): generate an override for the same capability against `tenant-b`, whose UI labels the same controls differently (a button *and* two field/control names, all templated off "Member" vs "Customer" terminology), then replay against it without re-recording:

```bash
npx tsx src/cli/index.ts generate-override --capability cap_fo6Vf548DW --for-tenant tenant-b
npm run replay -- --capability cap_fo6Vf548DW --for-tenant tenant-b --param username=operator --param password=operator123 --param memberId=12345
```

`evidence/README.md` §4 shows this one didn't work on the first try either — the override generator initially covered only the one drift I'd noticed, and two more replays surfaced two more, before the override logic was generalized to catch the whole class rather than one control at a time.

**6. Stability signal** (stretch goal): replay the same capability N times and report a real pass/fail distribution, not a single anecdotal run:

```bash
npm run stability-check -- --capability cap_fo6Vf548DW --runs 5 --param username=operator --param password=operator123 --param memberId=12345
```

Writes a `stability-report.json` (per-run status, duration, recovery-event count, and a success rate) to `evidence/stability_.../`. See `evidence/README.md` §5 for a real run's numbers.

## Troubleshooting

- **Groq rate limits (429) during discovery**: the free/on-demand tier has a low tokens-per-minute ceiling, and this loop resends the full growing conversation each turn, so a multi-step discovery run can legitimately hit it. `discover` retries automatically, honoring the API's own `retry-after` — a single run can pause for anywhere from a few seconds up to several minutes if you've been running discovery repeatedly against the same key. This is expected, not a bug; just let it retry.

## Human escalation / handoff

The browser runs headful on purpose. When discovery gets stuck (`request_human`, repeated failures, or a step budget exceeded) or replay hits a risky step or an unrecoverable condition, automation pauses, prints an intervention record under `evidence/.../*.request.json`, and prompts in the terminal — take control of the visible Chrome window directly, then press Enter to hand control back. Pass `--auto-resume-escalations` to skip the interactive prompt for non-interactive/CI runs (used for the risky-step confirmation gate specifically).

## Project layout

```
mock-app/         the target surface — legacy-style back office, 2 tenants
src/agent/        discovery: LLM-driven observe -> decide -> act loop (Groq)
src/artifact/     the Capability schema (Zod), storage, and parameterization
src/surface/      Playwright driver: accessibility-tree observation, actions, locator resolution
src/replay/       deterministic replay executor + error taxonomy
src/safety/       allowlist enforcement, risk classification, redaction
src/escalation/   human-in-the-loop handoff (same live session)
src/capabilities/ agent-facing capability catalog + invoke-by-name
src/canon/        cross-tenant locator-override generation
src/cli/          discover | replay | invoke | list-capabilities | generate-override
tests/            unit tests (no browser required)
evidence/         real discovery + replay run logs/screenshots (see REPORT.md)
```

## Configuration

`src/safety/allowlist.config.json` — the explicit, editable allowlist: permitted origins, permitted action types, which action types are treated as risky, and the max steps per discovery run.
