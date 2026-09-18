#!/usr/bin/env node
import { Command } from "commander";
import { runDiscovery } from "../agent/loop.js";
import { launchSurface } from "../surface/browser.js";
import { loadAllowlistConfig } from "../safety/allowlist.js";
import { saveCapability, loadCapability, listCapabilities, saveTenantOverride, loadTenantOverride } from "../artifact/store.js";
import { parameterize, type ParamSpec } from "../artifact/parameterize.js";
import { curateKnownConditions } from "../replay/known-conditions.js";
import { replayCapability } from "../replay/executor.js";
import { listCapabilityCatalog, invokeCapability } from "../capabilities/registry.js";
import { generateLabelDriftOverride } from "../canon/override.js";
import { TENANTS } from "../../mock-app/tenants.js";
import { RateLimitBackoffTooLong } from "../agent/loop.js";

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
  .option("--model <model>", "Groq model id", "openai/gpt-oss-120b")
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
  .action(async (opts) => {
    const capability = loadCapability(opts.capability);
    const params = parseParams(opts.param);
    if (opts.forTenant) params.baseTenant = opts.forTenant;
    else params.baseTenant ??= capability.provenance.baseTenant;

    const override = opts.forTenant && opts.forTenant !== capability.provenance.baseTenant ? (loadTenantOverride(capability.id, opts.forTenant) ?? undefined) : undefined;
    const allowlist = loadAllowlistConfig();

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

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof RateLimitBackoffTooLong) {
    console.error(`\n[rate limited] ${err.message}`);
    console.error(`Groq's on-demand tier ran out of headroom for now. Wait a bit and rerun the same command — discovery has not written a partial/corrupt artifact.`);
    process.exit(2);
  }
  throw err;
});
