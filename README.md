# Computer-Use Automation System

A discover-once, replay-many automation system for legacy back-office UIs that have no API: an LLM figures out a task once against a live surface, that run is recorded as a typed, versioned **capability**, and the capability then replays deterministically — no model in the loop — with a real error taxonomy and a human-escalation path for anything it can't safely handle alone.

See [REPORT.md](./REPORT.md) for the design write-up (architecture, artifact schema, error handling, heterogeneity/multi-tenant story, escalation, safety, and cuts).

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
  --goal "Log in, look up member 12345, read their savings balance, then open a Holiday Club sub-account with a $500 initial deposit and reach the confirmation screen." \
  --tenant tenant-a \
  --param memberId=12345 \
  --param accountType="Holiday Club" \
  --param depositAmount=500
```

This prints the saved artifact path, e.g. `artifacts/cap_xxxxxxxxxx.v1.json`, and writes a full step-by-step log plus screenshots to `evidence/discover_.../`.

**3. Replay the resulting artifact deterministically** (no LLM involved):

```bash
npm run replay -- \
  --capability <capability-id-from-step-2> \
  --param memberId=12345 \
  --param depositAmount=500
```

Try it against conditions the capability wasn't literally recorded on, to see the error taxonomy in action:

```bash
# a record that doesn't exist — a legitimate business outcome, not a crash
npm run replay -- --capability <id> --param memberId=00000 --param depositAmount=500

# a deposit above the confirmation threshold — recovered automatically as a known interstitial
npm run replay -- --capability <id> --param memberId=12345 --param depositAmount=15000

# a deposit below the minimum — a validation-error business outcome
npm run replay -- --capability <id> --param memberId=12345 --param depositAmount=5
```

**4. Invoke it the way an AI agent would** (the agent-facing capability interface — a thin wrapper over the same replay engine):

```bash
npm run list-capabilities
npm run invoke -- --capability <capability-name-or-id> --param memberId=12345 --param depositAmount=500
```

**5. Cross-tenant reuse** (stretch goal): generate an override for the same capability against `tenant-b`, whose "Open Sub-Account" button is labeled differently, then replay against it without re-recording:

```bash
npm run build -- # (compiles; or use tsx directly, see package.json)
npx tsx src/cli/index.ts generate-override --capability <capability-id> --for-tenant tenant-b
npm run replay -- --capability <capability-id> --for-tenant tenant-b --param memberId=12345 --param depositAmount=500
```

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
