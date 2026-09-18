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
import { evaluateCheckpoint } from "../replay/checkpoint.js";

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
  const model = opts.model ?? "openai/gpt-oss-20b"; // see README "Troubleshooting" — the 120b default hit this account's on-demand quota repeatedly in practice
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

    let completion;
    try {
      completion = await callGroqWithRetry(groq, { model, messages, tools: AGENT_TOOLS as any, tool_choice: "required", temperature: 0.1 }, logger);
    } catch (err: any) {
      const synthesized = trySynthesizeFinishFromFailedGeneration(err);
      if (!synthesized) throw err;
      logger.warn("synthesized_finish_from_failed_generation", { raw: err?.error?.error?.failed_generation });
      completion = synthesized;
    }

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
      // Never trust the model's self-reported checkpoint blindly — verify it
      // against the *current* live page before accepting it. Observed in
      // practice: the model read the confirmation, then navigated elsewhere
      // to fetch a value for the final answer, then called finish still
      // citing the confirmation text — which was no longer on screen. A
      // capability recorded with an unverified checkpoint would never
      // actually satisfy it on replay, since replay checks it against
      // whatever page the LAST recorded step actually lands on.
      const checkpointHolds = await evaluateCheckpoint(opts.page, { kind: "textPresent", text: args.successCheckpointText || "" });
      if (!checkpointHolds) {
        logger.warn("finish_checkpoint_not_live", { claimed: args.successCheckpointText, currentUrl: opts.page.url() });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `ERROR: successCheckpointText "${args.successCheckpointText}" is not present on the current page (${opts.page.url()}). If you navigated away after completing the goal, either navigate back to the confirming page before finishing, or cite checkpoint text that is actually visible right now.`,
        });
        continue;
      }
      // Only promote outputs that are actually backed by a recorded
      // extract_labeled_value step. The model's `finish` call can name
      // outputs it merely *read visually* without ever calling extract —
      // observed in practice: it declared `newAccountId` in its outputs
      // with no corresponding step, which would silently produce a
      // missing value on every future replay despite the schema promising
      // it. A self-reported-but-unbacked output is dropped, not trusted.
      const unbackedOutputKeys = Object.keys(args.outputs ?? {}).filter((k) => !(k in outputsCollected));
      if (unbackedOutputKeys.length > 0) {
        logger.warn("dropped_unbacked_outputs", {
          keys: unbackedOutputKeys,
          reason: "declared in finish() without a corresponding extract_labeled_value step",
        });
      }
      const outputs: OutputSpec[] = Object.keys(outputsCollected).map((k) => ({
        name: k,
        type: typeof outputsCollected[k] === "number" ? "number" : "string",
        description: `Extracted value for ${k}`,
        sourceStepId: steps.find((s) => s.action === "extract" && s.outputKey === k)!.stepId,
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

/**
 * Groq's `tool_choice: "required"` sometimes rejects a generation outright
 * (400 `tool_use_failed`) even when the model's intent is completely clear —
 * observed in practice at the very end of a successful run, where the model
 * produced well-formed `finish` arguments as raw content instead of a proper
 * tool call, and Groq refused the response rather than returning it. Rather
 * than losing an otherwise-successful discovery run to an API-level
 * formatting quirk, recover narrowly: only when the rejected generation
 * parses as JSON containing `successCheckpointText` (a field unique to the
 * `finish` tool's schema) do we treat it as an implicit finish call. Any
 * other shape is not guessed at — this is not a general error swallower.
 */
export function trySynthesizeFinishFromFailedGeneration(err: any): any | null {
  const code = err?.error?.error?.code;
  const failedGeneration = err?.error?.error?.failed_generation;
  if (code !== "tool_use_failed" || typeof failedGeneration !== "string") return null;

  let parsed: any;
  try {
    parsed = JSON.parse(failedGeneration);
  } catch {
    return null;
  }
  if (typeof parsed?.successCheckpointText !== "string") return null;

  const toolCall = {
    id: `synthesized_${Date.now()}`,
    type: "function",
    function: { name: "finish", arguments: JSON.stringify(parsed) },
  };
  return { choices: [{ message: { role: "assistant", content: null, tool_calls: [toolCall] } }] };
}

export class RateLimitBackoffTooLong extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Groq rate limit requires waiting ${Math.ceil(retryAfterMs / 1000)}s, past the ${Math.ceil(MAX_INPROCESS_WAIT_MS / 1000)}s ceiling this process will block for`);
    this.name = "RateLimitBackoffTooLong";
  }
}

// A single process sleeping for minutes at a time is fragile under any
// supervising process (a CI job, a shell with its own timeout, this very
// development sandbox — which is exactly what surfaced this: a prior run
// was killed mid-wait by an external timeout while honoring an 11-minute
// `retry-after`). Bounding the in-process wait and failing fast past it
// means the caller decides when to retry, instead of a child process
// gambling on surviving an arbitrarily long blocking sleep.
const MAX_INPROCESS_WAIT_MS = 90_000;

/**
 * Groq's free/on-demand tier has a low tokens-per-minute ceiling, and this
 * loop resends the full growing message history every turn — a long
 * discovery run WILL hit 429s in practice, not just in theory (this is not
 * hypothetical: it happened during development of this exact capability).
 * Honor the API's own `retry-after` when given, otherwise back off
 * exponentially; anything else (a real auth/schema error) is not retried.
 */
async function callGroqWithRetry(
  groq: Groq,
  params: { model: string; messages: any[]; tools: any; tool_choice: "required"; temperature: number },
  logger: RunLogger,
  maxAttempts = 6
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await groq.chat.completions.create(params);
    } catch (err: any) {
      const status = err?.status;
      if (status !== 429) throw err;
      const retryAfterHeader = err?.headers?.["retry-after"];
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Math.min(2000 * 2 ** (attempt - 1), 30000);
      if (waitMs > MAX_INPROCESS_WAIT_MS) {
        logger.error("groq_rate_limit_exceeds_wait_ceiling", { attempt, waitMs, ceilingMs: MAX_INPROCESS_WAIT_MS });
        throw new RateLimitBackoffTooLong(waitMs);
      }
      if (attempt === maxAttempts) throw err;
      logger.warn("groq_rate_limited_retrying", { attempt, maxAttempts, waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error("unreachable");
}
