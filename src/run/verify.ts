import type { Page } from 'playwright';
import { buildLocator, describeLocator } from '../browser/locator.js';
import type { BaselineOutcome } from '../baseline/types.js';

export interface VerificationResult {
  ok: boolean;
  /** Human-readable statement of what was checked and what was seen. */
  detail: string;
  /** What was asserted, for the run log. */
  checked: string;
}

const OUTCOME_TIMEOUT = 5000;

/**
 * Checks the recorded post-condition against the live page.
 *
 * This is the verifier half of "LLM proposes, Playwright verifies" — the same
 * function stage 4 will use to decide whether a healed candidate is acceptable,
 * which is exactly why it takes an outcome rather than a step.
 */
export async function verifyOutcome(
  page: Page,
  outcome: BaselineOutcome,
): Promise<VerificationResult> {
  switch (outcome.type) {
    case 'urlContains': {
      const expected = outcome.value ?? '';
      const checked = `urlContains "${expected}"`;
      await page
        .waitForURL((url) => url.href.includes(expected), { timeout: OUTCOME_TIMEOUT })
        .catch(() => {});
      const actual = page.url();
      return {
        ok: actual.includes(expected),
        checked,
        detail: `Expected the URL to contain "${expected}", but it is "${actual}".`,
      };
    }

    case 'elementVisible': {
      if (!outcome.locator) {
        return { ok: false, checked: 'elementVisible', detail: 'No locator was recorded.' };
      }
      const checked = `elementVisible ${describeLocator(outcome.locator)}`;
      const locator = buildLocator(page, outcome.locator);
      const visible = await locator
        .first()
        .waitFor({ state: 'visible', timeout: OUTCOME_TIMEOUT })
        .then(() => true)
        .catch(() => false);
      return {
        ok: visible,
        checked,
        detail: `Expected ${describeLocator(outcome.locator)} to be visible; it was not.`,
      };
    }

    case 'inputFilled': {
      if (!outcome.locator) {
        return { ok: false, checked: 'inputFilled', detail: 'No locator was recorded.' };
      }
      const checked = `inputFilled ${describeLocator(outcome.locator)}`;
      const value = await buildLocator(page, outcome.locator)
        .inputValue({ timeout: OUTCOME_TIMEOUT })
        .catch(() => null);
      return {
        ok: value !== null && value.length > 0,
        checked,
        // The value itself is never logged — it may be a password.
        detail: 'Expected the field to hold a value after being filled; it was empty.',
      };
    }

    case 'none':
      // Recorded as unverifiable at baseline time. Passing it is not evidence of
      // anything, so the run log says so rather than claiming a green check.
      return { ok: true, checked: 'none (no post-condition)', detail: 'Nothing to verify.' };
  }
}
