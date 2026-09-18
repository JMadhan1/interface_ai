import { chromium, type Page } from "playwright";

/**
 * Headful by design (not headless): when discovery or replay escalates to a
 * human, the escalation mechanism relies on a real, visible browser window
 * the operator can take over directly — see src/escalation/handoff.ts.
 * Set HEADLESS=true to run headless for CI/automated test runs where no
 * human handoff will occur.
 */
export async function launchSurface(): Promise<{ page: Page; close: () => Promise<void> }> {
  const headless = process.env.HEADLESS === "true";
  // Use the system-installed Chrome by default (PLAYWRIGHT_CHANNEL=chromium
  // to use Playwright's bundled browser instead, if you've run
  // `npx playwright install chromium`).
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? "chrome";
  const browser = await chromium.launch(channel === "chromium" ? { headless } : { headless, channel });
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    page,
    close: async () => {
      await browser.close();
    },
  };
}
