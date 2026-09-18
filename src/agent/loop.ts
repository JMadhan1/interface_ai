import Groq from "groq-sdk";
import { nanoid } from "nanoid";
import type { Page } from "playwright";
import { SurfaceDriver } from "../surface/act.js";
import { observe } from "../surface/observe.js";
import { AGENT_TOOLS } from "./tools.js";
import { systemPrompt } from "./prompt.js";
import type { AllowlistConfig } from "../safety/allowlist.js";
import type { ActionStep, Capability, InputParam, OutputSpec } from "../artifact/schema.js";
import { RunLogger } from "../logging/logger.js";
import { raiseIntervention } from "../escalation/handoff.js";

export interface DiscoveryResult {
  outcome: "completed" | "escalated" | "stopped";
  capability?: Capability;
  runId: string;
}

export async function runDiscovery(opts: {
  page: Page;
  goal: string;
  targetBaseUrl: string;
  startUrl: string;
  baseTenant: string;
  allowlist: AllowlistConfig;
  groqApiKey: string;
  model?: string;
  maxSteps?: number;
  evidenceDir: string;
  declaredInputParams?: InputParam[];
  autoResumeEscalations?: boolean;
}): Promise<DiscoveryResult> {
  const runId = `discover_${nanoid(8)}`;
  const logger = new RunLogger(`${opts.evidenceDir}/${runId}/log.jsonl`, runId);
  const model = opts.model ?? "llama-3.3-70b-versatile";
  const maxSteps = opts.maxSteps ?? 25;
  const groq = new Groq({ apiKey: opts.groqApiKey });
  const driver = new SurfaceDriver(opts.page, opts.allowlist);

  const messages: any[] = [{ role: "system", content: systemPrompt(opts.goal, opts.allowlist.allowedOrigins) }];
  const steps: ActionStep[] = [];
  const outputsCollected: Record<string, string | number> = {};
  let consecutiveToolErrors = 0;

  logger.info("discovery_started", { goal: opts.goal, targetBaseUrl: opts.targetBaseUrl, model });

  // The initial navigation is deterministic infrastructure, not a model
  // decision — it also anchors sessionBootstrapStepCount (see schema.ts).
  const initialNavStep = await driver.navigate(opts.startUrl);
  steps.push(initialNavStep);
  logger.info("initial_navigate", { url: opts.startUrl });

  for (let i = 0; i < maxSteps; i++) {
    const obs = await observe(opts.page);
    messages.push({
      role: "user",
      content: `PAGE: ${obs.url}\nTITLE: ${obs.title}\nINTERACTIVE ELEMENTS:\n${obs.interactiveSummary}\n\nVISIBLE TEXT:\n${obs.visibleText}`,
    });
    logger.info("observation", { step: i, url: obs.url, title: obs.title });

    const completion = await groq.chat.completions.create({
      model,
      messages,
      tools: AGENT_TOOLS as any,
      tool_choice: "required",
      temperature: 0.1,
    });

    const choice = completion.choices[0];
    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall) {
      logger.warn("no_tool_call", { content: choice?.message?.content });
      messages.push({ role: "user", content: "You must call exactly one tool." });
      continue;
    }
    messages.push(choice.message);

    const name = toolCall.function.name;
    let args: any = {};
    try {
      args = JSON.parse(toolCall.function.arguments || "{}");
    } catch {
      logger.warn("bad_tool_args", { name, raw: toolCall.function.arguments });
    }
    logger.info("tool_call", { step: i, name, args });

    if (name === "finish") {
      const outputKeys = Object.keys(args.outputs ?? outputsCollected);
      const outputs: OutputSpec[] = outputKeys.map((k) => ({
        name: k,
        type: typeof (outputsCollected[k] ?? args.outputs?.[k]) === "number" ? "number" : "string",
        description: `Extracted value for ${k}`,
        sourceStepId: steps.find((s) => s.action === "extract" && s.outputKey === k)?.stepId ?? "unknown",
      }));
      const capability: Capability = {
        schemaVersion: "1.0",
        id: `cap_${nanoid(10)}`,
        name: summarizeGoalAsName(opts.goal),
        description: opts.goal,
        version: 1,
        provenance: {
          goal: opts.goal,
          targetBaseUrl: opts.targetBaseUrl,
          baseTenant: opts.baseTenant,
          model,
          discoveryRunId: runId,
          discoveredAt: new Date().toISOString(),
        },
        inputParams: opts.declaredInputParams ?? [],
        steps,
        sessionBootstrapStepCount: 0,
        knownInterstitials: [],
        businessOutcomes: [],
        outputs,
        successCheckpoint: { kind: "textPresent", text: args.successCheckpointText || args.summary || "done" },
      };
      logger.info("discovery_finished", { summary: args.summary, outputs });
      return { outcome: "completed", capability, runId };
    }

    if (name === "request_human") {
      logger.warn("agent_requested_human", { reason: args.reason });
      await raiseIntervention({
        reason: args.reason ?? "agent requested human assistance",
        goal: opts.goal,
        page: opts.page,
        evidenceDir: `${opts.evidenceDir}/${runId}`,
        logger,
        autoResume: opts.autoResumeEscalations,
      });
      return { outcome: "escalated", runId };
    }

    try {
      const { step, resultText, value } = await executeTool(driver, name, args);
      steps.push(step);
      if (name === "extract_labeled_value" && value !== undefined) {
        outputsCollected[args.outputKey] = value;
      }
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
      logger.info("tool_result", { step: i, name, ok: true, resultText });
      consecutiveToolErrors = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: `ERROR: ${message}` });
      logger.warn("tool_result", { step: i, name, ok: false, error: message });
      consecutiveToolErrors++;
      if (consecutiveToolErrors >= 3) {
        logger.warn("repeated_failures_escalating", { count: consecutiveToolErrors });
        await raiseIntervention({
          reason: `${consecutiveToolErrors} consecutive action failures — agent appears stuck`,
          goal: opts.goal,
          page: opts.page,
          evidenceDir: `${opts.evidenceDir}/${runId}`,
          logger,
          autoResume: opts.autoResumeEscalations,
        });
        return { outcome: "escalated", runId };
      }
    }
  }

  logger.warn("discovery_max_steps_exceeded", { maxSteps });
  await raiseIntervention({
    reason: `Discovery did not complete within ${maxSteps} steps (dead-end / timeout stopping condition)`,
    goal: opts.goal,
    page: opts.page,
    evidenceDir: `${opts.evidenceDir}/${runId}`,
    logger,
    autoResume: opts.autoResumeEscalations,
  });
  return { outcome: "stopped", runId };
}

async function executeTool(
  driver: SurfaceDriver,
  name: string,
  args: any
): Promise<{ step: ActionStep; resultText: string; value?: string | number }> {
  switch (name) {
    case "navigate": {
      const step = await driver.navigate(args.url);
      return { step, resultText: `Navigated to ${args.url}` };
    }
    case "click": {
      const step = await driver.click(args.role, args.name, args.intent);
      return { step, resultText: `Clicked ${args.role} "${args.name}"` };
    }
    case "fill": {
      const step = await driver.fill(args.label, args.value, args.intent, !!args.sensitive);
      return { step, resultText: `Filled "${args.label}"` };
    }
    case "select_option": {
      const step = await driver.selectOption(args.label, args.value, args.intent);
      return { step, resultText: `Selected "${args.value}" for "${args.label}"` };
    }
    case "wait_for_text": {
      const step = await driver.waitForText(args.text, args.intent);
      return { step, resultText: `Text appeared: "${args.text}"` };
    }
    case "extract_labeled_value": {
      const { step, value } = await driver.extractLabeledValue(args.label, args.outputKey, args.as, args.intent);
      return { step, resultText: `Extracted ${args.outputKey} = ${value}`, value };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function summarizeGoalAsName(goal: string): string {
  return goal.length > 60 ? goal.slice(0, 57) + "..." : goal;
}
