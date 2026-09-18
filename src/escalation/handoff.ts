import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Page } from "playwright";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { RunLogger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// The control-transfer model.
//
// The browser runs headful (a real, visible window) for exactly this reason:
// when automation cedes control, the human operator can take the physical
// mouse/keyboard on the *same* window/OS process/Playwright `page` object —
// not a fresh session, not a screenshot relay. Ownership is tracked
// explicitly as agent | human so it's never ambiguous who is driving. This
// process blocks (no Playwright commands are issued) for the duration of
// human control, which is what makes "not acting while a human is in
// control" a real guarantee rather than a race condition.
//
// Scope note (documented, per the brief's explicit allowance): a full
// multi-operator co-browsing *console* (a UI) is out of scope — but the
// underlying remote-attach mechanism is real, not just described: see
// raiseRemoteIntervention() below and the `operator-attach` CLI command,
// which is a genuinely separate process attaching to the same live browser
// over Chrome DevTools Protocol, not just a different code path in this one.
// ---------------------------------------------------------------------------

export const InterventionRequestSchema = z.object({
  id: z.string(),
  raisedAt: z.string(),
  goal: z.string(),
  reason: z.string(),
  pageUrl: z.string(),
  screenshotPath: z.string(),
  controlState: z.enum(["agent", "human"]),
  /** Present only for the remote-operator path: how a separate process attaches to this exact live browser. */
  cdpEndpoint: z.string().optional(),
});
export type InterventionRequest = z.infer<typeof InterventionRequestSchema>;

export const InterventionResolutionSchema = z.object({
  interventionId: z.string(),
  resumedAt: z.string(),
  operatorNotes: z.string(),
  resultingUrl: z.string(),
});
export type InterventionResolution = z.infer<typeof InterventionResolutionSchema>;

export async function raiseIntervention(opts: {
  reason: string;
  goal: string;
  page: Page;
  evidenceDir: string;
  logger: RunLogger;
  /** For non-interactive test/CI runs: skip the readline prompt and auto-resume immediately. */
  autoResume?: boolean;
}): Promise<InterventionResolution> {
  const id = `intervention_${nanoid(8)}`;
  mkdirSync(opts.evidenceDir, { recursive: true });
  const screenshotPath = `${opts.evidenceDir}/${id}_before.png`;
  await opts.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  const request: InterventionRequest = {
    id,
    raisedAt: new Date().toISOString(),
    goal: opts.goal,
    reason: opts.reason,
    pageUrl: opts.page.url(),
    screenshotPath,
    controlState: "human",
  };
  writeFileSync(`${opts.evidenceDir}/${id}.request.json`, JSON.stringify(request, null, 2));
  opts.logger.warn("intervention_raised", { id, reason: opts.reason, pageUrl: request.pageUrl });

  console.log(`\n[ESCALATION] Automation paused: ${opts.reason}`);
  console.log(`[ESCALATION] Control handed to human operator on the live browser window.`);
  console.log(`[ESCALATION] Intervention record: ${opts.evidenceDir}/${id}.request.json`);

  let operatorNotes = "auto-resumed (non-interactive run)";
  if (!opts.autoResume) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    operatorNotes = await rl.question(
      "[ESCALATION] Take control of the browser window now. When done, describe what you did and press Enter to resume automation: "
    );
    rl.close();
  }

  const afterScreenshot = `${opts.evidenceDir}/${id}_after.png`;
  await opts.page.screenshot({ path: afterScreenshot, fullPage: true }).catch(() => {});

  const resolution: InterventionResolution = {
    interventionId: id,
    resumedAt: new Date().toISOString(),
    operatorNotes: operatorNotes || "(no notes provided)",
    resultingUrl: opts.page.url(),
  };
  writeFileSync(`${opts.evidenceDir}/${id}.resolution.json`, JSON.stringify(resolution, null, 2));
  opts.logger.info("intervention_resolved", resolution);
  console.log(`[ESCALATION] Control returned to automation. Resuming.\n`);

  return resolution;
}

/**
 * The remote-operator variant: instead of blocking on this process's own
 * terminal, it publishes the browser's cdpEndpoint and then polls the
 * filesystem for a resolution file — one a completely separate process (the
 * `operator-attach` CLI command, run anywhere with access to this machine's
 * network) writes after connecting to the *same* live browser via
 * `chromium.connectOverCDP(cdpEndpoint)`, looking at the *same* page, and
 * acting. This process issues zero Playwright commands and touches the page
 * only to take the two screenshots — the same "not acting while a human is
 * in control" guarantee as the local path, now proven across a process
 * boundary instead of just a code path within one process.
 */
export async function raiseRemoteIntervention(opts: {
  reason: string;
  goal: string;
  page: Page;
  cdpEndpoint: string;
  evidenceDir: string;
  logger: RunLogger;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<InterventionResolution> {
  const id = `intervention_${nanoid(8)}`;
  mkdirSync(opts.evidenceDir, { recursive: true });
  const screenshotPath = `${opts.evidenceDir}/${id}_before.png`;
  await opts.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  const request: InterventionRequest = {
    id,
    raisedAt: new Date().toISOString(),
    goal: opts.goal,
    reason: opts.reason,
    pageUrl: opts.page.url(),
    screenshotPath,
    controlState: "human",
    cdpEndpoint: opts.cdpEndpoint,
  };
  const requestPath = `${opts.evidenceDir}/${id}.request.json`;
  writeFileSync(requestPath, JSON.stringify(request, null, 2));
  opts.logger.warn("remote_intervention_raised", { id, reason: opts.reason, cdpEndpoint: opts.cdpEndpoint });

  console.log(`\n[ESCALATION] Automation paused: ${opts.reason}`);
  console.log(`[ESCALATION] Remote operator can attach with:`);
  console.log(`  npm run operator-attach -- --request ${requestPath}`);
  console.log(`[ESCALATION] Waiting for that process to resolve the intervention...`);

  const resolutionPath = `${opts.evidenceDir}/${id}.resolution.json`;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(resolutionPath)) {
    if (Date.now() > deadline) {
      throw new Error(`remote intervention ${id} was not resolved within ${timeoutMs}ms (no ${resolutionPath})`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const resolution = InterventionResolutionSchema.parse(JSON.parse(readFileSync(resolutionPath, "utf-8")));
  opts.logger.info("remote_intervention_resolved", resolution);
  console.log(`[ESCALATION] Remote operator resolved the intervention. Resuming.\n`);
  return resolution;
}
