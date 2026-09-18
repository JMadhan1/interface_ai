#!/usr/bin/env node
import { Command } from "commander";
import { runDiscovery } from "../agent/loop.js";
import { launchSurface, launchSurfaceServer, attachToSurface } from "../surface/browser.js";
import { InterventionRequestSchema, InterventionResolutionSchema } from "../escalation/handoff.js";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadAllowlistConfig } from "../safety/allowlist.js";
import { saveCapability, loadCapability, listCapabilities, saveTenantOverride, loadTenantOverride } from "../artifact/store.js";
import { parameterize, type ParamSpec } from "../artifact/parameterize.js";
import { curateKnownConditions } from "../replay/known-conditions.js";
import { replayCapability } from "../replay/executor.js";
import { listCapabilityCatalog, invokeCapability } from "../capabilities/registry.js";
import { generateLabelDriftOverride } from "../canon/override.js";
import { TENANTS } from "../../mock-app/tenants.js";
import { RateLimitBackoffTooLong } from "../agent/loop.js";
import { runStabilityCheck } from "../replay/stability.js";

const program = new Command();
program.name("capability-cli").description("Discover, replay, and invoke computer-use capabilities.");

function parseParams(pairs: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx === -1) throw new Error(`invalid --param "${pair}", expected key=value`);
    out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}

program
  .command("discover")
  .requiredOption("--goal <text>", "natural language goal")
  .option("--tenant <slug>", "target tenant", "tenant-a")
  .option("--base-url <url>", "mock app base URL", "http://localhost:4100")
  .option("--model <model>", "Groq model id", "openai/gpt-oss-20b")
  .option("--max-steps <n>", "max discovery steps", "25")
  .option("--param <key=value...>", "literal->param name mapping to parameterize, e.g. memberId=12345", (v, acc: string[]) => [...acc, v], [])
  .option("--auto-resume-escalations", "don't block on human input if the agent escalates (for CI)", false)
  .action(async (opts) => {
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) throw new Error("GROQ_API_KEY is not set");
    const tenantConfig = TENANTS[opts.tenant];
    if (!tenantConfig) throw new Error(`unknown tenant: ${opts.tenant}`);
    const allowlist = loadAllowlistConfig();

    const { page, close } = await launchSurface();
    try {
      const result = await runDiscovery({
        page,
        goal: opts.goal,
        targetBaseUrl: `${opts.baseUrl}/${opts.tenant}`,
        startUrl: `${opts.baseUrl}/${opts.tenant}/login`,
        baseTenant: opts.tenant,
        allowlist,
        groqApiKey,
        model: opts.model,
        maxSteps: Number(opts.maxSteps),
        evidenceDir: "evidence",
        autoResumeEscalations: opts.autoResumeEscalations,
      });

      console.log(`\nDiscovery outcome: ${result.outcome} (runId=${result.runId})`);
      if (result.outcome !== "completed" || !result.capability) {
        console.log("No capability was produced.");
        return;
      }

      let capability = result.capability;
      capability.sessionBootstrapStepCount = 4; // navigate, fill username, fill password, click Log In

      const paramPairs = parseParams(opts.param);
      const specs: ParamSpec[] = [
        { name: "username", type: "string", required: true, sensitive: true, description: "Operator login username", literalValue: paramPairs.username ?? "operator" },
        { name: "password", type: "string", required: true, sensitive: true, description: "Operator login password", literalValue: paramPairs.password ?? "operator123" },
      ];
      for (const [name, literalValue] of Object.entries(paramPairs)) {
        if (name === "username" || name === "password") continue;
        specs.push({ name, type: /^-?\d+(\.\d+)?$/.test(literalValue) ? "number" : "string", required: true, sensitive: false, description: `Business input: ${name}`, literalValue });
      }
      specs.push({ name: "baseTenant", type: "string", required: true, sensitive: false, description: "Which tenant to run against", literalValue: opts.tenant });

      capability = parameterize(capability, specs);

      const curated = curateKnownConditions(tenantConfig.entityLabel);
      capability.businessOutcomes = curated.businessOutcomes;
      capability.knownInterstitials = curated.knownInterstitials;

      const path = saveCapability(capability);
      console.log(`Saved capability: ${path}`);
      console.log(`  id=${capability.id} version=${capability.version}`);
      console.log(`  inputParams: ${capability.inputParams.map((p) => p.name).join(", ")}`);
      console.log(`  outputs: ${capability.outputs.map((o) => o.name).join(", ") || "(none)"}`);
    } finally {
      await close();
    }
  });

program
  .command("replay")
  .requiredOption("--capability <idOrPath>")
  .option("--param <key=value...>", "input param, e.g. memberId=12345", (v, acc: string[]) => [...acc, v], [])
  .option("--for-tenant <slug>", "replay against a different tenant using a saved override")
  .option("--auto-resume-escalations", "don't block on human input for risky-step confirmation", false)
  .option("--remote-operator", "hand risky-step confirmation to a separate `operator-attach` process instead of this terminal", false)
  .action(async (opts) => {
    const capability = loadCapability(opts.capability);
    const params = parseParams(opts.param);
    if (opts.forTenant) params.baseTenant = opts.forTenant;
    else params.baseTenant ??= capability.provenance.baseTenant;

    const override = opts.forTenant && opts.forTenant !== capability.provenance.baseTenant ? (loadTenantOverride(capability.id, opts.forTenant) ?? undefined) : undefined;
    const allowlist = loadAllowlistConfig();

    if (opts.remoteOperator) {
      const { page, cdpEndpoint, close } = await launchSurfaceServer();
      try {
        const result = await replayCapability({ page, capability, params, allowlist, evidenceDir: "evidence", tenantOverride: override, riskyStepPolicy: "confirm", cdpEndpoint });
        console.log(`\nReplay result:\n${JSON.stringify(result, null, 2)}`);
      } finally {
        await close();
      }
      return;
    }

    const { page, close } = await launchSurface();
    try {
      const result = await replayCapability({
        page,
        capability,
        params,
        allowlist,
        evidenceDir: "evidence",
        tenantOverride: override,
        riskyStepPolicy: "confirm",
        autoResumeEscalations: opts.autoResumeEscalations,
      });
      console.log(`\nReplay result:\n${JSON.stringify(result, null, 2)}`);
    } finally {
      await close();
    }
  });

program
  .command("invoke")
  .description("Agent-facing: invoke a saved capability by id or name with typed args.")
  .requiredOption("--capability <idOrName>")
  .option("--param <key=value...>", "", (v, acc: string[]) => [...acc, v], [])
  .option("--for-tenant <slug>")
  .action(async (opts) => {
    const args = parseParams(opts.param);
    const result = await invokeCapability({ capabilityIdOrName: opts.capability, args, forTenant: opts.forTenant });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("list-capabilities")
  .action(() => {
    const catalog = listCapabilityCatalog();
    if (catalog.length === 0) {
      console.log("No capabilities saved yet. Run `npm run discover` first.");
      return;
    }
    for (const c of catalog) {
      console.log(`- ${c.name} [${c.id} v${c.version}]`);
      console.log(`  ${c.description}`);
      console.log(`  inputs: ${c.inputParams.map((p) => `${p.name}${p.required ? "" : "?"}:${p.type}`).join(", ")}`);
      console.log(`  outputs: ${c.outputs.map((o) => `${o.name}:${o.type}`).join(", ") || "(none)"}`);
    }
  });

program
  .command("generate-override")
  .requiredOption("--capability <id>")
  .requiredOption("--for-tenant <slug>")
  .action((opts) => {
    const capability = loadCapability(opts.capability);
    const override = generateLabelDriftOverride(capability, opts.forTenant);
    const path = saveTenantOverride(override);
    console.log(`Saved override: ${path}`);
    console.log(JSON.stringify(override, null, 2));
  });

program
  .command("stability-check")
  .description("Replay a capability N times and report a pass/fail stability signal (brief §8 stretch goal).")
  .requiredOption("--capability <idOrPath>")
  .option("--param <key=value...>", "input param, e.g. memberId=12345", (v, acc: string[]) => [...acc, v], [])
  .option("--for-tenant <slug>", "run against a different tenant using a saved override")
  .option("--runs <n>", "number of independent replay runs", "5")
  .action(async (opts) => {
    const capability = loadCapability(opts.capability);
    const params = parseParams(opts.param);
    if (opts.forTenant) params.baseTenant = opts.forTenant;
    else params.baseTenant ??= capability.provenance.baseTenant;

    const override = opts.forTenant && opts.forTenant !== capability.provenance.baseTenant ? (loadTenantOverride(capability.id, opts.forTenant) ?? undefined) : undefined;
    const allowlist = loadAllowlistConfig();

    const report = await runStabilityCheck({
      capability,
      params,
      allowlist,
      evidenceDir: `evidence/stability_${capability.id}_${Date.now()}`,
      runs: Number(opts.runs),
      tenantOverride: override,
    });

    console.log(`\nStability report (${report.totalRuns} runs, capability ${report.capabilityId} v${report.capabilityVersion}):`);
    console.log(`  success rate: ${(report.successRate * 100).toFixed(0)}%`);
    console.log(`  status distribution: ${JSON.stringify(report.statusCounts)}`);
    console.log(`  all runs identical outcome: ${report.allIdentical}`);
    for (const r of report.runs) {
      console.log(`  run ${r.runIndex}: ${r.status} (${r.durationMs}ms, ${r.recoveryEventCount} recovery event(s))${r.detail ? ` — ${r.detail}` : ""}`);
    }
  });

program
  .command("operator-attach")
  .description(
    "Remote-operator handoff: run in a SEPARATE terminal (or a separate machine on the same network) from `replay --remote-operator`. " +
      "Connects to the exact live browser a paused run is using via its cdpEndpoint and resolves the intervention."
  )
  .requiredOption("--request <path>", "path to the intervention .request.json printed by the paused run")
  .action(async (opts) => {
    const request = InterventionRequestSchema.parse(JSON.parse(readFileSync(opts.request, "utf-8")));
    if (!request.cdpEndpoint) {
      throw new Error(`this intervention wasn't raised in remote-operator mode (no cdpEndpoint recorded) — rerun replay with --remote-operator`);
    }

    console.log(`Connecting to the live browser at ${request.cdpEndpoint} ...`);
    const { browser, close } = await attachToSurface(request.cdpEndpoint);
    try {
      const pages = browser.contexts().flatMap((c) => c.pages());
      const page = pages.find((p) => p.url() === request.pageUrl) ?? pages[0];
      if (!page) throw new Error("attached to the browser but found no open pages");

      console.log(`Attached. This is the SAME live session the paused run is using — not a fresh one.`);
      console.log(`Current page: ${page.url()}`);
      console.log(`Reason automation paused: ${request.reason}`);

      const beforePath = opts.request.replace(/\.request\.json$/, "_operator_view.png");
      await page.screenshot({ path: beforePath, fullPage: true }).catch(() => {});
      console.log(`Confirmation screenshot (proves this is the same page): ${beforePath}`);

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const operatorNotes = await rl.question("Take any action needed on the page above, then describe what you did and press Enter to resume automation: ");
      rl.close();

      const resolution = {
        interventionId: request.id,
        resumedAt: new Date().toISOString(),
        operatorNotes: operatorNotes || "(no notes provided)",
        resultingUrl: page.url(),
      };
      InterventionResolutionSchema.parse(resolution);
      const resolutionPath = opts.request.replace(/\.request\.json$/, ".resolution.json");
      writeFileSync(resolutionPath, JSON.stringify(resolution, null, 2));
      console.log(`Wrote ${resolutionPath} — the paused run will pick this up and resume.`);
    } finally {
      await close();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof RateLimitBackoffTooLong) {
    console.error(`\n[rate limited] ${err.message}`);
    console.error(`Groq's on-demand tier ran out of headroom for now. Wait a bit and rerun the same command — discovery has not written a partial/corrupt artifact.`);
    process.exit(2);
  }
  throw err;
});
