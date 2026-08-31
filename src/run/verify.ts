import type { Page } from 'playwright';
import { buildLocator, describeLocator } from '../browser/locator.js';
import type { Assertion, BaselineOutcome } from '../baseline/types.js';

export interface VerificationResult {
  ok: boolean;
  /** Human-readable statement of what was checked and what was seen. */
  detail: string;
  /** What was asserted, for the run log. */
  checked: string;
}

const OUTCOME_TIMEOUT = 5000;

/**
 * Checks every recorded post-condition against the live page. All must hold.
 *
 * This is the verifier half of "LLM proposes, Playwright verifies" — the same
 * function stage 4 uses to decide whether a healed candidate is acceptable,
 * which is exactly why it takes an outcome rather than a step.
 */
export async function verifyOutcome(
  page: Page,
  outcome: BaselineOutcome,
): Promise<VerificationResult> {
  if (outcome.assertions.length === 0) {
    // Recorded as unverifiable at baseline time. Passing it is not evidence of
    // anything, so the run log says so rather than claiming a green check.
    return { ok: true, checked: 'none (no post-condition)', detail: 'Nothing to verify.' };
  }

  const checked: string[] = [];
  for (const assertion of outcome.assertions) {
    const result = await verifyAssertion(page, assertion);
    checked.push(result.checked);
    // Stops at the first failure: the remaining assertions describe a state the
    // app never reached, so their results would not add anything.
    if (!result.ok) {
      return { ok: false, checked: checked.join(' + '), detail: result.detail };
    }
  }

  return { ok: true, checked: checked.join(' + '), detail: 'All post-conditions held.' };
}

async function verifyAssertion(page: Page, assertion: Assertion): Promise<VerificationResult> {
  switch (assertion.type) {
    case 'urlContains': {
      const expected = assertion.value ?? '';
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
      if (!assertion.locator) {
        return { ok: false, checked: 'elementVisible', detail: 'No locator was recorded.' };
      }
      const checked = `elementVisible ${describeLocator(assertion.locator)}`;
      const visible = await buildLocator(page, assertion.locator)
        .first()
        .waitFor({ state: 'visible', timeout: OUTCOME_TIMEOUT })
        .then(() => true)
        .catch(() => false);
      return {
        ok: visible,
        checked,
        detail: `Expected ${describeLocator(assertion.locator)} to be visible; it was not.`,
      };
    }

    case 'textEquals': {
      if (!assertion.locator) {
        return { ok: false, checked: 'textEquals', detail: 'No locator was recorded.' };
      }
      const expected = assertion.value ?? '';
      const checked = `textEquals "${expected}"`;
      const actual = await buildLocator(page, assertion.locator)
        .first()
        .textContent({ timeout: OUTCOME_TIMEOUT })
        .then((text) => (text ?? '').replace(/\s+/g, ' ').trim())
        .catch(() => null);
      return {
        ok: actual === expected,
        checked,
        // The value the tester asked for, so safe to print — unlike a filled field.
        detail: `Expected ${describeLocator(assertion.locator)} to read "${expected}", but it reads "${actual ?? '(not found)'}".`,
      };
    }

    case 'inputFilled': {
      if (!assertion.locator) {
        return { ok: false, checked: 'inputFilled', detail: 'No locator was recorded.' };
      }
      const checked = `inputFilled ${describeLocator(assertion.locator)}`;
      const value = await buildLocator(page, assertion.locator)
        .inputValue({ timeout: OUTCOME_TIMEOUT })
        .catch(() => null);
      return {
        ok: value !== null && value.length > 0,
        checked,
        // The value itself is never logged — it may be a password.
        detail: 'Expected the field to hold a value after being filled; it was empty.',
      };
    }
  }
}
