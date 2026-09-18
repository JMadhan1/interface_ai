import { mkdirSync } from "node:fs";
import type { Page } from "playwright";
import { nanoid } from "nanoid";
import type { ActionStep, Capability, TenantOverride } from "../artifact/schema.js";
import { assertOriginAllowed, type AllowlistConfig } from "../safety/allowlist.js";
import { resolveLocatorChain } from "../surface/locate.js";
import { evaluateCheckpoint } from "./checkpoint.js";
import { HARD_SERVER_ERROR_MARKER, SESSION_EXPIRED_MARKER, TRANSIENT_UNAVAILABLE_MARKER } from "./known-conditions.js";
import { RunLogger } from "../logging/logger.js";
import { raiseIntervention, raiseRemoteIntervention } from "../escalation/handoff.js";

export interface RecoveryEvent {
  kind: "known_interstitial" | "session_timeout" | "transient_retry";
  detail: string;
  atStepId: string;
}

export type ReplayResult =
  | { status: "success"; outputs: Record<string, string | number>; recoveryEvents: RecoveryEvent[]; stepsExecuted: number; evidenceDir: string }
  | { status: "business_outcome"; code: string; detail: string; recoveryEvents: RecoveryEvent[]; stepsExecuted: number; evidenceDir: string }
  | { status: "hard_failure"; stepId: string; expected: string; observed: string; recoveryEvents: RecoveryEvent[]; stepsExecuted: number; evidenceDir: string; screenshotPath: string }
  | { status: "escalated"; interventionId: string; evidenceDir: string };

const MAX_TRANSIENT_RETRIES = 3;

export async function replayCapability(opts: {
  page: Page;
  capability: Capability;
  params: Record<string, string | number | boolean>;
  allowlist: AllowlistConfig;
  evidenceDir: string;
  tenantOverride?: TenantOverride;
  riskyStepPolicy?: "auto" | "confirm";
  autoResumeEscalations?: boolean;
  /** When set, risky-step confirmation is handed to a genuinely separate operator process over Chrome DevTools Protocol instead of this process's own terminal — see src/escalation/handoff.ts and src/surface/browser.ts. */
  cdpEndpoint?: string;
}): Promise<ReplayResult> {
  const runId = `replay_${nanoid(8)}`;
  const evidenceDir = `${opts.evidenceDir}/${runId}`;
  mkdirSync(evidenceDir, { recursive: true });
  const logger = new RunLogger(`${evidenceDir}/log.jsonl`, runId);
  const cap = opts.capability;
  const steps = applyOverride(cap.steps, opts.tenantOverride);
  const outputs: Record<string, string | number> = {};
  const recoveryEvents: RecoveryEvent[] = [];
  let transientRetries = 0;
  let sessionRelogins = 0;
  let riskyConfirmed = opts.riskyStepPolicy !== "confirm";

  logger.info("replay_started", {
    capabilityId: cap.id,
    version: cap.version,
    tenantOverride: opts.tenantOverride?.forTenant ?? null,
    paramKeys: Object.keys(opts.params),
  });

  // Shared by the pre-step check inside the loop AND the post-loop check
  // (a business outcome or interstitial can just as easily be the result of
  // the *last* recorded step, e.g. a confirmation interstitial that only
  // appears after the final submit — not just something encountered
  // mid-flow). Loops internally until conditions clear or a terminal result
  // is reached, so multiple recoverable conditions in a row are all handled.
  async function drainRuntimeConditions(referenceStep: ActionStep, stepIndex: number): Promise<ReplayResult | null> {
    for (;;) {
      const condition = await checkRuntimeConditions(opts.page, cap);
      if (!condition) return null;

      if (condition.kind === "business_outcome") {
        logger.info("replay_business_outcome", { code: condition.code });
        return { status: "business_outcome", code: condition.code, detail: condition.detail, recoveryEvents, stepsExecuted: stepIndex, evidenceDir };
      }
      if (condition.kind === "known_interstitial") {
        const resolved = await resolveLocatorChain(opts.page, condition.interstitial.dismissAction.locators);
        if (!resolved) {
          return await hardFailure(opts.page, referenceStep, "known interstitial's dismiss control to be present", "dismiss control not found", evidenceDir, recoveryEvents, stepIndex);
        }
        await resolved.locator.click();
        recoveryEvents.push({ kind: "known_interstitial", detail: condition.interstitial.id, atStepId: referenceStep.stepId });
        logger.warn("recovered_known_interstitial", { id: condition.interstitial.id });
        continue;
      }
      if (condition.kind === "session_expired") {
        if (sessionRelogins >= 1) {
          return await hardFailure(opts.page, referenceStep, "session re-established after relogin", "session expired again immediately", evidenceDir, recoveryEvents, stepIndex);
        }
        sessionRelogins++;
        // Re-authenticating alone isn't enough to resume mid-flow: the
        // browser has no state beyond what's currently on screen, so we
        // have to re-walk every step before this one (not just the login
        // prefix) to get back to the page this step actually expects.
        // Safe here because all pre-extract steps in this flow are
        // idempotent reads/navigations; a capability whose early steps
        // include non-idempotent mutations would need step-level
        // idempotency markers before this replay-from-start recovery could
        // apply safely — flagged as a known limitation in REPORT.md.
        for (const priorStep of steps.slice(0, stepIndex)) {
          await executeReplayStep(opts.page, priorStep, opts.params, opts.allowlist);
        }
        recoveryEvents.push({ kind: "session_timeout", detail: `re-authenticated and replayed ${stepIndex} prior step(s) to restore state`, atStepId: referenceStep.stepId });
        logger.warn("recovered_session_timeout", { replayedSteps: stepIndex });
        continue;
      }
      if (condition.kind === "transient") {
        if (transientRetries >= MAX_TRANSIENT_RETRIES) {
          return await hardFailure(opts.page, referenceStep, "page to load successfully", "repeated transient unavailability", evidenceDir, recoveryEvents, stepIndex);
        }
        transientRetries++;
        await opts.page.waitForTimeout(300 * transientRetries);
        await opts.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        recoveryEvents.push({ kind: "transient_retry", detail: `attempt ${transientRetries}`, atStepId: referenceStep.stepId });
        logger.warn("recovered_transient", { attempt: transientRetries });
        continue;
      }
      if (condition.kind === "hard_error") {
        return await hardFailure(opts.page, referenceStep, "a recognized page state", "unrecognized server error page", evidenceDir, recoveryEvents, stepIndex);
      }
    }
  }

  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;

    const preStepResult = await drainRuntimeConditions(step, i);
    if (preStepResult) return preStepResult;

    if (step.riskLevel === "risky" && !riskyConfirmed) {
      const reason = `Replay is about to perform a mutating (risky) action: "${step.intent}". Approve to continue.`;
      if (opts.cdpEndpoint) {
        await raiseRemoteIntervention({ reason, goal: cap.description, page: opts.page, cdpEndpoint: opts.cdpEndpoint, evidenceDir, logger });
      } else {
        await raiseIntervention({ reason, goal: cap.description, page: opts.page, evidenceDir, logger, autoResume: opts.autoResumeEscalations });
      }
      riskyConfirmed = true;
    }

    try {
      const result = await executeReplayStep(opts.page, step, opts.params, opts.allowlist);
      if (result) outputs[result.outputKey] = result.value;
      logger.info("step_ok", { i, stepId: step.stepId, action: step.action });
      i++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("step_failed", { i, stepId: step.stepId, error: message });
      return await hardFailure(opts.page, step, describeExpected(step), message, evidenceDir, recoveryEvents, i);
    }
  }

  const postLoopResult = await drainRuntimeConditions(steps[steps.length - 1]!, steps.length);
  if (postLoopResult) return postLoopResult;

  const finalOk = await evaluateCheckpoint(opts.page, cap.successCheckpoint);
  if (!finalOk) {
    return await hardFailure(
      opts.page,
      steps[steps.length - 1]!,
      `success checkpoint satisfied: ${JSON.stringify(cap.successCheckpoint)}`,
      "checkpoint not satisfied after all steps executed",
      evidenceDir,
      recoveryEvents,
      steps.length
    );
  }

  logger.info("replay_success", { outputs });
  return { status: "success", outputs, recoveryEvents, stepsExecuted: steps.length, evidenceDir };
}

// ---------------------------------------------------------------------------

type RuntimeCondition =
  | { kind: "business_outcome"; code: string; detail: string }
  | { kind: "known_interstitial"; interstitial: Capability["knownInterstitials"][number] }
  | { kind: "session_expired" }
  | { kind: "transient" }
  | { kind: "hard_error" };

async function checkRuntimeConditions(page: Page, cap: Capability): Promise<RuntimeCondition | null> {
  for (const bo of cap.businessOutcomes) {
    if (await evaluateCheckpoint(page, bo.matchCheckpoint)) {
      return { kind: "business_outcome", code: bo.code, detail: bo.description };
    }
  }
  for (const ki of cap.knownInterstitials) {
    if (await evaluateCheckpoint(page, ki.matchCheckpoint)) {
      return { kind: "known_interstitial", interstitial: ki };
    }
  }
  if ((await page.getByText(SESSION_EXPIRED_MARKER, { exact: false }).count()) > 0) return { kind: "session_expired" };
  if ((await page.getByText(TRANSIENT_UNAVAILABLE_MARKER, { exact: false }).count()) > 0) return { kind: "transient" };
  if ((await page.getByText(HARD_SERVER_ERROR_MARKER, { exact: false }).count()) > 0) return { kind: "hard_error" };
  return null;
}

function resolveTemplate(value: string, params: Record<string, unknown>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in params)) throw new Error(`missing required param: ${name}`);
    return String(params[name]);
  });
}

async function executeReplayStep(
  page: Page,
  step: ActionStep,
  params: Record<string, unknown>,
  allowlist: AllowlistConfig
): Promise<{ outputKey: string; value: string | number } | undefined> {
  switch (step.action) {
    case "navigate": {
      const url = resolveTemplate(step.url, params);
      assertOriginAllowed(url, allowlist);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return undefined;
    }
    case "click": {
      const resolved = await resolveLocatorChain(page, step.locators);
      if (!resolved) throw new Error(`locator chain exhausted (click): ${step.intent}`);
      await resolved.locator.click();
      return undefined;
    }
    case "fill": {
      const resolved = await resolveLocatorChain(page, step.locators);
      if (!resolved) throw new Error(`locator chain exhausted (fill): ${step.intent}`);
      const value = resolveTemplate(step.value, params);
      await resolved.locator.fill(value);
      return undefined;
    }
    case "select": {
      const resolved = await resolveLocatorChain(page, step.locators);
      if (!resolved) throw new Error(`locator chain exhausted (select): ${step.intent}`);
      const value = resolveTemplate(step.value, params);
      await resolved.locator.selectOption(value);
      return undefined;
    }
    case "waitForText": {
      await page.getByText(step.text, { exact: false }).first().waitFor({ timeout: step.timeoutMs });
      return undefined;
    }
    case "extract": {
      const resolved = await resolveLocatorChain(page, step.locators);
      if (!resolved) throw new Error(`locator chain exhausted (extract): ${step.intent}`);
      const raw = (await resolved.locator.innerText()).trim();
      const value = step.extractAs === "number" ? Number(raw.replace(/[^0-9.-]/g, "")) : raw;
      return { outputKey: step.outputKey, value };
    }
    case "assertCheckpoint": {
      const ok = await evaluateCheckpoint(page, step.condition);
      if (!ok) throw new Error(`checkpoint not satisfied: ${JSON.stringify(step.condition)}`);
      return undefined;
    }
  }
}


function applyOverride(steps: ActionStep[], override?: TenantOverride): ActionStep[] {
  if (!override) return steps;
  return steps.map((step) => {
    const ov = override.locatorOverrides[step.stepId];
    if (!ov || !("locators" in step)) return step;
    return { ...step, locators: [...ov, ...(step as any).locators] } as ActionStep;
  });
}

function describeExpected(step: ActionStep): string {
  switch (step.action) {
    case "navigate":
      return `navigation to ${step.url} to succeed`;
    case "click":
      return `target for "${step.intent}" to be clickable`;
    case "fill":
    case "select":
      return `target for "${step.intent}" to be present`;
    case "waitForText":
      return `text "${step.text}" to appear`;
    case "extract":
      return `value for "${step.intent}" to be readable`;
    case "assertCheckpoint":
      return `checkpoint to be satisfied`;
  }
}

async function hardFailure(
  page: Page,
  step: ActionStep,
  expected: string,
  observed: string,
  evidenceDir: string,
  recoveryEvents: RecoveryEvent[],
  stepsExecuted: number
): Promise<ReplayResult> {
  mkdirSync(evidenceDir, { recursive: true });
  const screenshotPath = `${evidenceDir}/hard_failure_${step.stepId}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return { status: "hard_failure", stepId: step.stepId, expected, observed, recoveryEvents, stepsExecuted, evidenceDir, screenshotPath };
}
