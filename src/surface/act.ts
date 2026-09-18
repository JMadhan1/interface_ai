import { nanoid } from "nanoid";
import type { Page } from "playwright";
import type { ActionStep, LocatorChain } from "../artifact/schema.js";
import { assertActionTypeAllowed, assertOriginAllowed, classifyRisk, type AllowlistConfig } from "../safety/allowlist.js";
import { resolveLocatorChain } from "./locate.js";

/**
 * Normalizes a form-field label into the template/param name used for
 * sensitive values ("Password" -> "password"). Exported and unit-tested
 * directly: a mismatch between this and how a capability's input params are
 * named silently breaks every replay (a caller supplies `password` but the
 * recorded step looks for `{{Password}}`) with no type error to catch it.
 */
export function toParamName(label: string): string {
  return label.replace(/\s+/g, "").replace(/^./, (c) => c.toLowerCase());
}

export class ActionError extends Error {
  constructor(
    message: string,
    public readonly step: Partial<ActionStep>
  ) {
    super(message);
    this.name = "ActionError";
  }
}

/**
 * Executes semantic actions against a live page and returns the resulting
 * ActionStep record (with its locator fallback chain) so the discovery loop
 * can accumulate a capability artifact. The LLM never invents a raw CSS
 * selector — it expresses intent ("click the button named X"), and this
 * layer is responsible for turning that into a robust, ranked locator chain.
 * That separation is deliberate: it keeps brittle selector-guessing out of
 * the model's hands entirely.
 */
export class SurfaceDriver {
  constructor(
    private page: Page,
    private allowlist: AllowlistConfig
  ) {}

  private stepId() {
    return `step_${nanoid(8)}`;
  }

  async navigate(url: string): Promise<ActionStep> {
    assertActionTypeAllowed("navigate", this.allowlist);
    assertOriginAllowed(url, this.allowlist);
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    return { stepId: this.stepId(), action: "navigate", url, intent: `Navigate to ${url}`, riskLevel: classifyRisk("navigate", this.allowlist) };
  }

  async click(role: string, name: string, intent: string): Promise<ActionStep> {
    assertActionTypeAllowed("click", this.allowlist);
    const chain: LocatorChain = [
      { kind: "role", role, name, confidence: 0.9, rationale: "Accessible role+name is the most stable identifier for interactive controls, independent of markup/CSS." },
      { kind: "text", text: name, exact: true, confidence: 0.55, rationale: "Fallback: exact visible text, in case the role changes but the label doesn't." },
    ];
    const resolved = await resolveLocatorChain(this.page, chain);
    if (!resolved) throw new ActionError(`click target not found: role=${role} name="${name}"`, { action: "click", intent });
    await resolved.locator.click();
    return { stepId: this.stepId(), action: "click", locators: chain, intent, riskLevel: classifyRisk("click", this.allowlist) };
  }

  async fill(label: string, value: string, intent: string, sensitive = false): Promise<ActionStep> {
    assertActionTypeAllowed("fill", this.allowlist);
    const chain: LocatorChain = [
      { kind: "label", label, confidence: 0.9, rationale: "<label for> association is standard even on legacy server-rendered forms and survives styling/markup churn." },
    ];
    const resolved = await resolveLocatorChain(this.page, chain);
    if (!resolved) throw new ActionError(`fill target not found: label="${label}"`, { action: "fill", intent });
    await resolved.locator.fill(value);
    return { stepId: this.stepId(), action: "fill", locators: chain, value: sensitive ? `{{${toParamName(label)}}}` : value, intent, riskLevel: classifyRisk("fill", this.allowlist), sensitive };
  }

  async selectOption(label: string, value: string, intent: string): Promise<ActionStep> {
    assertActionTypeAllowed("select", this.allowlist);
    const chain: LocatorChain = [{ kind: "label", label, confidence: 0.9, rationale: "<label for> association identifies the <select> element." }];
    const resolved = await resolveLocatorChain(this.page, chain);
    if (!resolved) throw new ActionError(`select target not found: label="${label}"`, { action: "select", intent });
    await resolved.locator.selectOption(value);
    return { stepId: this.stepId(), action: "select", locators: chain, value, intent, riskLevel: classifyRisk("select", this.allowlist) };
  }

  async waitForText(text: string, intent: string, timeoutMs = 5000): Promise<ActionStep> {
    assertActionTypeAllowed("waitForText", this.allowlist);
    await this.page.getByText(text, { exact: false }).first().waitFor({ timeout: timeoutMs });
    return { stepId: this.stepId(), action: "waitForText", text, timeoutMs, intent, riskLevel: classifyRisk("waitForText", this.allowlist) };
  }

  async extractLabeledValue(
    label: string,
    outputKey: string,
    as: "text" | "number",
    intent: string
  ): Promise<{ step: ActionStep; value: string | number }> {
    assertActionTypeAllowed("extract", this.allowlist);
    const chain: LocatorChain = [
      {
        kind: "adjacentCell",
        rowLabelText: label,
        cellIndex: 2,
        confidence: 0.65,
        rationale: "This app renders fields as two-column label/value table rows; finds the exact-text label node, walks to its closest ancestor row, and reads that row's 2nd direct cell.",
      },
      {
        kind: "css",
        selector: `xpath=//td[normalize-space(.)="${label}"]/following-sibling::td[1]`,
        confidence: 0.5,
        rationale: "Structural fallback via XPath sibling traversal, independent of table row semantics, for markup that isn't exactly two <td> columns.",
      },
    ];
    const resolved = await resolveLocatorChain(this.page, chain);
    if (!resolved) throw new ActionError(`extract target not found: label="${label}"`, { action: "extract", intent });
    const raw = (await resolved.locator.innerText()).trim();
    const value = as === "number" ? Number(raw.replace(/[^0-9.-]/g, "")) : raw;
    return {
      step: { stepId: this.stepId(), action: "extract", locators: chain, outputKey, extractAs: as, intent, riskLevel: classifyRisk("extract", this.allowlist) },
      value,
    };
  }
}
