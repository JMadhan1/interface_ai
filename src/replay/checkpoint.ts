import type { Page } from "playwright";
import type { CheckpointCondition } from "../artifact/schema.js";
import { resolveLocatorChain } from "../surface/locate.js";

export async function evaluateCheckpoint(page: Page, condition: CheckpointCondition): Promise<boolean> {
  switch (condition.kind) {
    case "textPresent": {
      const count = await page.getByText(condition.text, { exact: false }).count();
      return count > 0;
    }
    case "textAbsent": {
      const count = await page.getByText(condition.text, { exact: false }).count();
      return count === 0;
    }
    case "urlMatches": {
      return new RegExp(condition.pattern).test(page.url());
    }
    case "elementVisible": {
      const resolved = await resolveLocatorChain(page, condition.locators);
      return resolved !== null;
    }
  }
}
