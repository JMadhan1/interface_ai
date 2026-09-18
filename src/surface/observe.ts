import type { Page } from "playwright";

export interface Observation {
  url: string;
  title: string;
  /** Compact, LLM-readable rendering of the accessibility tree (Playwright's own YAML-ish aria snapshot). */
  interactiveSummary: string;
  /** Short dump of visible text (e.g. table values) the LLM may need to read/extract. */
  visibleText: string;
}

/**
 * Observation is accessibility-tree text, not a screenshot. This is the
 * approach that still works on a surface with no clean DOM and no vision
 * model — the tradeoff and its limits are discussed in REPORT.md.
 */
export async function observe(page: Page): Promise<Observation> {
  const snapshot = await page
    .locator("body")
    .ariaSnapshot()
    .catch(() => "(accessibility tree unavailable)");

  const visibleText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    // Kept deliberately tight: this loop resends the full growing message
    // history every turn, and Groq's on-demand tier has an 8000 TPM ceiling
    // — a multi-step flow hits that limit in practice with larger payloads
    // (see callGroqWithRetry in agent/loop.ts for the complementary fix).
    interactiveSummary: snapshot.slice(0, 1800),
    visibleText: visibleText.slice(0, 700),
  };
}
