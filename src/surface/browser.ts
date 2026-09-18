import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright";

function resolveLaunchOptions(headless: boolean) {
  // Use the system-installed Chrome by default (PLAYWRIGHT_CHANNEL=chromium
  // to use Playwright's bundled browser instead, if you've run
  // `npx playwright install chromium`).
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? "chrome";
  return channel === "chromium" ? { headless } : { headless, channel };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Headful by design (not headless): when discovery or replay escalates to a
 * human, the escalation mechanism relies on a real, visible browser window
 * the operator can take over directly — see src/escalation/handoff.ts.
 * Set HEADLESS=true to run headless for CI/automated test runs where no
 * human handoff will occur.
 */
export async function launchSurface(): Promise<{ page: Page; close: () => Promise<void> }> {
  const headless = process.env.HEADLESS === "true";
  const browser = await chromium.launch(resolveLaunchOptions(headless));
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    page,
    close: async () => {
      await browser.close();
    },
  };
}

/**
 * The remote-operator escalation path (REPORT.md §5's "documented
 * extension," now actually built): a genuinely separate process can attach
 * to this exact live browser and see/drive the exact same page — not just a
 * different code path within one process.
 *
 * Implementation note, found by testing rather than assumed: the first
 * version of this used `chromium.launchServer()` + `chromium.connect()`,
 * which is Playwright's own client-session protocol — empirically, a
 * *second* `connect()` call from a separate process does NOT see contexts
 * created by the first (`browser.contexts()` came back empty even after
 * waiting). Chrome DevTools Protocol doesn't have that limitation — it
 * reflects real browser-process state, not a Playwright-client-scoped
 * session — so this launches Chrome directly with `--remote-debugging-port`
 * and any process attaches via `chromium.connectOverCDP()` instead.
 */
export async function launchSurfaceServer(): Promise<{
  page: Page;
  cdpEndpoint: string;
  close: () => Promise<void>;
}> {
  const headless = process.env.HEADLESS === "true";
  const port = await findFreePort();
  const options = resolveLaunchOptions(headless);
  const browser = await chromium.launch({ ...options, args: [`--remote-debugging-port=${port}`] });
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    page,
    cdpEndpoint: `http://localhost:${port}`,
    close: async () => {
      await browser.close();
    },
  };
}

/**
 * What a separate operator process calls to attach to a running session's
 * browser by its CDP endpoint. The operator finds the page under escalation
 * by URL (recorded in the intervention request), not by creating a new one.
 */
export async function attachToSurface(cdpEndpoint: string): Promise<{ browser: Browser; close: () => Promise<void> }> {
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  return {
    browser,
    // Disconnect only — the operator does not own this browser's lifecycle,
    // the session that launched it does.
    close: async () => {
      await browser.close();
    },
  };
}
