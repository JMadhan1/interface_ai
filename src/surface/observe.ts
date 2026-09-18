import type { Page } from "playwright";

export interface Observation {
  url: string;
  title: string;
  /** Compact, LLM-readable rendering of the interactive accessibility tree. */
  interactiveSummary: string;
  /** Short dump of visible text (e.g. table values) the LLM may need to read/extract. */
  visibleText: string;
}

const INTERESTING_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "heading",
  "cell",
  "columnheader",
  "row",
]);

interface AXNode {
  role?: string;
  name?: string;
  value?: string | number;
  children?: AXNode[];
}

/**
 * Observation is accessibility-tree text, not a screenshot. This is the
 * approach that still works on a surface with no clean DOM and no vision
 * model — the tradeoff and its limits are discussed in REPORT.md.
 */
export async function observe(page: Page): Promise<Observation> {
  const snapshot = (await (page as any).accessibility.snapshot({ interestingOnly: true })) as AXNode | null;
  const lines: string[] = [];

  function walk(node: AXNode | null | undefined) {
    if (!node) return;
    const role = node.role ?? "";
    const name = (node.name ?? "").trim();
    if (INTERESTING_ROLES.has(role) && (name || node.value !== undefined)) {
      const valuePart = node.value !== undefined && node.value !== "" ? ` value="${node.value}"` : "";
      lines.push(`- ${role} "${name}"${valuePart}`);
    }
    for (const child of node.children ?? []) walk(child);
  }
  walk(snapshot);

  const visibleText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    interactiveSummary: lines.join("\n") || "(no interactive elements detected)",
    visibleText: visibleText.slice(0, 2000),
  };
}
