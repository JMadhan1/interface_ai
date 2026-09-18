# Computer-Use Automation System

**Give an AI agent hands inside software that has no API.**

[![CI](https://github.com/JMadhan1/interface_ai/actions/workflows/ci.yml/badge.svg)](https://github.com/JMadhan1/interface_ai/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-31%20passing-brightgreen)](./tests)

An LLM figures out how to complete a task once, against a real, live legacy UI. That run is recorded as a typed, versioned **capability**. From then on, the capability replays **deterministically — no model, no API cost, no re-reasoning** — with a real error taxonomy for the runtime conditions that legitimately occur, and a human-escalation path for the one time something truly can't be handled alone.

<p align="center"><img src="./docs/architecture.svg" alt="Architecture: discover once with an LLM in the loop, record a typed capability, replay deterministically, escalate to a human when stuck" width="100%"></p>

<table>
<tr><td>

**This isn't a description of a system — it's a report on one that was actually run.** Every claim below is backed by a real execution in [`/evidence`](./evidence): a genuine Groq-driven discovery run, five replay scenarios (including two real cross-tenant *failures* before the fix that made it work), and a 5-run stability check. Along the way, three real bugs were caught and fixed by running the system, not by inspection — each is documented at the point it was found. See [`REPORT.md`](./REPORT.md) for the full design write-up.

</td></tr>
</table>

---

## Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Running without live services](#running-without-live-services)
- [Demo path](#demo-path) — six runnable steps, end to end
- [Troubleshooting](#troubleshooting)
- [Human escalation / handoff](#human-escalation--handoff)
- [Project layout](#project-layout)
- [Configuration](#configuration)

---

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

| Command | What it does | Touches Groq? | Touches a browser? |
|---|---|:---:|:---:|
| `npm test` | Unit tests — schema, parameterization, redaction, allowlist, override generation | No | No |
| `npm run replay` | Deterministic replay against the local mock app — the production execution path | No | Yes (local) |
| `npm run invoke` | Agent-facing capability interface, same guarantee as replay | No | Yes (local) |
| `npm run stability-check` | Replay N times, report a real pass/fail distribution | No | Yes (local) |
| `npm run discover` | The one LLM-driven run | **Yes** | Yes (local) |

## Demo path

**1 — Start the target application** (a legacy-style credit union back office, two tenants, in a separate terminal):

```bash
npm run mock-app
```

Serves `http://localhost:4100`, with tenants `tenant-a` (Meridian Credit Union) and `tenant-b` (Harborline Financial) — the same underlying app, different branding, one deliberately drifted button label, and an extra schema column on tenant-b. Login for both: `operator` / `operator123`.

**2 — Run discovery** (drives a real, visible Chrome window with an LLM deciding every action):

```bash
GROQ_API_KEY=your_key npm run discover -- \
  --goal 'Log in with username operator and password operator123. Then look up member 12345, read their savings balance, then open a Holiday Club sub-account for them with a 500 dollar initial deposit and reach the confirmation screen showing the new account ID.' \
  --tenant tenant-a \
  --model openai/gpt-oss-20b \
  --param memberId=12345 \
  --param accountType="Holiday Club" \
  --param depositAmount=500
```

> **Use single quotes around `--goal`**, not double quotes — a `$` followed by digits inside a double-quoted string is parsed by the shell as a positional parameter and silently stripped, which is exactly what happened while building this (`"$500"` became `"00"` in one run — see `evidence/README.md`). `--model openai/gpt-oss-20b` is a deliberate recommendation: this account's model list didn't include the usual Llama models, and the larger default (`openai/gpt-oss-120b`) hit Groq's on-demand quota repeatedly during development.

This prints the saved artifact path, e.g. `artifacts/cap_xxxxxxxxxx.v1.json`, and writes a step-by-step log to `evidence/discover_.../`. **What the model actually does — which values it uses, whether it self-corrects out of a validation error, whether it extracts every value you'd want — varies run to run.** `evidence/README.md` documents exactly what happened on the real run behind the capability already included in this repo (`cap_fo6Vf548DW`), including two real bugs it surfaced and how they were fixed — a worked example you can inspect without spending your own Groq quota.

**3 — Replay the resulting artifact deterministically** (no LLM involved) — using the included real capability:

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

**4 — Invoke it the way an AI agent would** (the agent-facing capability interface — a thin wrapper over the same replay engine):

```bash
npm run list-capabilities
npm run invoke -- --capability cap_fo6Vf548DW --param username=operator --param password=operator123 --param memberId=12345
```

**5 — Cross-tenant reuse** *(stretch goal)*: generate an override for the same capability against `tenant-b`, whose UI labels the same controls differently (a button *and* two field/control names, all templated off "Member" vs "Customer" terminology), then replay against it **without re-recording**:

```bash
npx tsx src/cli/index.ts generate-override --capability cap_fo6Vf548DW --for-tenant tenant-b
npm run replay -- --capability cap_fo6Vf548DW --for-tenant tenant-b --param username=operator --param password=operator123 --param memberId=12345
```

`evidence/README.md` §4 shows this one didn't work on the first try either — the override generator initially covered only the one drift noticed up front, and two more replays surfaced two more, before the logic was generalized to catch the whole class rather than one control at a time.

**6 — Stability signal** *(stretch goal)*: replay the same capability N times and report a real pass/fail distribution, not a single anecdotal run:

```bash
npm run stability-check -- --capability cap_fo6Vf548DW --runs 5 --param username=operator --param password=operator123 --param memberId=12345
```

Writes `stability-report.json` (per-run status, duration, recovery-event count, and a success rate) to `evidence/stability_.../`. See `evidence/README.md` §5 for a real run's numbers.

## Troubleshooting

- **Groq rate limits (429) during discovery** — the free/on-demand tier has a low tokens-per-minute ceiling, and this loop resends the full growing conversation each turn, so a multi-step discovery run can legitimately hit it. `discover` retries automatically, honoring the API's own `retry-after` — a single run can pause anywhere from a few seconds to several minutes if you've been running discovery repeatedly against the same key. This is expected, not a bug; just let it retry.

## Human escalation / handoff

The browser runs headful on purpose. When discovery gets stuck (`request_human`, repeated failures, or a step budget exceeded) or replay hits a risky step or an unrecoverable condition, automation pauses, prints an intervention record under `evidence/.../*.request.json`, and prompts in the terminal — take control of the visible Chrome window directly, then press Enter to hand control back. Pass `--auto-resume-escalations` to skip the interactive prompt for non-interactive/CI runs (used for the risky-step confirmation gate specifically).

## Project layout

```
mock-app/         the target surface — legacy-style back office, 2 tenants
src/agent/        discovery: LLM-driven observe -> decide -> act loop (Groq)
src/artifact/     the Capability schema (Zod), storage, and parameterization
src/surface/      Playwright driver: accessibility-tree observation, actions, locator resolution
src/replay/       deterministic replay executor + error taxonomy + stability signal
src/safety/       allowlist enforcement, risk classification, redaction
src/escalation/   human-in-the-loop handoff (same live session)
src/capabilities/ agent-facing capability catalog + invoke-by-name
src/canon/        cross-tenant locator-override generation
src/cli/          discover | replay | invoke | list-capabilities | generate-override | stability-check
tests/            unit tests (no browser required)
evidence/         real discovery + replay run logs/screenshots (see REPORT.md)
```

## Configuration

`src/safety/allowlist.config.json` — the explicit, editable allowlist: permitted origins, permitted action types, which action types are treated as risky, and the max steps per discovery run.

---

<p align="center"><sub>Built for the interface.ai Applied AI Engineer take-home. See <a href="./REPORT.md">REPORT.md</a> for the full design reasoning, and <a href="./evidence">/evidence</a> for the real runs behind every claim above.</sub></p>
