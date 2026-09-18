import { mkdirSync, writeFileSync } from "node:fs";
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
// Scope note (documented, per the brief's explicit allowance): a remote,
// multi-operator co-browsing console is out of scope. The natural extension
// — documented in REPORT.md — is `chromium.launchServer()` + a second
// process connecting via `chromium.connect(wsEndpoint)` so a remote operator
// UI could attach to the same live browser without being co-located.
// ---------------------------------------------------------------------------

export const InterventionRequestSchema = z.object({
  id: z.string(),
  raisedAt: z.string(),
  goal: z.string(),
  reason: z.string(),
  pageUrl: z.string(),
  screenshotPath: z.string(),
  controlState: z.enum(["agent", "human"]),
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
