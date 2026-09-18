import type { Locator, Page } from "playwright";
import type { LocatorChain, LocatorStrategy } from "../artifact/schema.js";

// 2000ms was too tight in practice: live discovery logs showed a `fill`
// occasionally miss on its first attempt right after a form-submit redirect
// (server-rendered page, no client JS — the miss is Playwright's own
// load/attach timing, not the app being genuinely slow) and succeed a few
// seconds later on model retry. Widened rather than papered over by adding
// artificial delay elsewhere.
const ATTEMPT_TIMEOUT_MS = 4000;

/**
 * The single locator resolver shared by discovery-time verification and
 * production replay. Tries each strategy in the chain in order, returning
 * the first one that resolves to exactly one visible/attached element. This
 * is what makes replay deterministic and "no clean DOM" survivable: if the
 * top-confidence strategy (role+name) breaks, we fall back rather than fail
 * outright — but we also report *which* strategy actually worked, so drift
 * is visible instead of silent.
 */
export async function resolveLocatorChain(
  page: Page,
  chain: LocatorChain
): Promise<{ locator: Locator; usedStrategy: LocatorStrategy; strategyIndex: number } | null> {
  for (let i = 0; i < chain.length; i++) {
    const strategy = chain[i]!;
    try {
      const locator = strategyToLocator(page, strategy);
      await locator.waitFor({ state: "attached", timeout: ATTEMPT_TIMEOUT_MS });
      const count = await locator.count();
      if (count === 1) {
        return { locator, usedStrategy: strategy, strategyIndex: i };
      }
      // count === 0 handled by waitFor throwing; count > 1 is ambiguous — skip to next strategy.
    } catch {
      // this strategy didn't resolve in time; fall through to the next one
    }
  }
  return null;
}

function strategyToLocator(page: Page, strategy: LocatorStrategy): Locator {
  switch (strategy.kind) {
    case "role":
      return page.getByRole(strategy.role as any, { name: strategy.name, exact: false });
    case "label":
      return page.getByLabel(strategy.label, { exact: false });
    case "text":
      return page.getByText(strategy.text, { exact: strategy.exact });
    case "css":
      return page.locator(strategy.selector);
    case "adjacentCell":
      return page
        .getByText(strategy.rowLabelText, { exact: true })
        .locator(`xpath=./ancestor::tr[1]/td[${strategy.cellIndex}]`);
    case "coordinates":
      // Coordinates are a last-resort synthetic locator: we wrap the exact
      // point in a locator-like object via page mouse click at resolve time
      // instead — handled specially by callers. Here we approximate with
      // the root element so waitFor/count succeed; act() special-cases this.
      return page.locator("body");
  }
}
