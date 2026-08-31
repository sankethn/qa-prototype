import type { Page } from 'playwright';
import type { PageSnapshot } from '../browser/extract.js';
import { resolveLocators } from '../browser/locator.js';
import type { Action } from '../intent/types.js';
import type { Assertion, BaselineOutcome, Locator } from './types.js';

export interface DeriveOutcomeParams {
  page: Page;
  action: Action;
  /** The step's own locator; null for steps that act on no element. */
  stepLocator: Locator | null;
  /** Set only when the tester named a literal value for an assert step. */
  expectedValue: string | null;
  intended: string | null;
  urlBefore: string;
  urlAfter: string;
  before: PageSnapshot;
  after: PageSnapshot;
}

/**
 * Turns the intent plan's prose expectation into typed, checkable assertions —
 * from what actually happened, not from what the model predicted.
 *
 * This is why baseline generation runs the flow for real. The plan may have said
 * "the checkout page is displayed"; only the browser knows that means `/checkout`
 * and which element proves it rendered. The prose is kept in `intended` as
 * context for the healer, but it is never what gets asserted.
 *
 * Assertions accumulate rather than compete: a click that navigated records both
 * the URL and something that only exists on the destination, so "we got there"
 * cannot pass on an error page served at the same path.
 */
export async function deriveOutcome({
  page,
  action,
  stepLocator,
  expectedValue,
  intended,
  urlBefore,
  urlAfter,
  before,
  after,
}: DeriveOutcomeParams): Promise<BaselineOutcome> {
  const assertions: Assertion[] = [];
  const add = (type: Assertion['type'], value: string | null, locator: Locator | null) =>
    assertions.push({ type, value, locator });

  // An assert step's post-condition is the thing it was asserting.
  if ((action === 'assert' || action === 'waitFor') && stepLocator) {
    add('elementVisible', null, stepLocator);

    // Only when the tester named the value. Otherwise the test checks that a
    // value is displayed, and a later data change is not a failure.
    if (expectedValue !== null) add('textEquals', expectedValue, stepLocator);
  }

  // A fill's post-condition is that the field holds the value. The value itself
  // is never recorded — it may be a password.
  if (action === 'fill' && stepLocator) {
    add('inputFilled', null, stepLocator);
  }

  const urlFragment = distinguishingUrlFragment(urlBefore, urlAfter);
  if (urlFragment) add('urlContains', urlFragment, null);

  // Something that was not on the page before: the destination's heading after a
  // navigation, a badge that shows an item was added, a confirmation banner.
  // Paired with the URL assertion this is what makes the outcome hard to satisfy
  // accidentally.
  if (assertions.length === 0 || urlFragment) {
    const appeared = await firstAppearedLocator(page, before, after);
    if (appeared) add('elementVisible', null, appeared);
  }

  // An empty list is recorded honestly rather than papered over with an
  // assertion that would pass whatever the app does.
  return { assertions, intended };
}

/** The smallest part of the new URL that tells it apart from the old one. */
function distinguishingUrlFragment(urlBefore: string, urlAfter: string): string | null {
  let before: URL;
  let after: URL;
  try {
    before = new URL(urlBefore);
    after = new URL(urlAfter);
  } catch {
    return null;
  }

  if (before.pathname !== after.pathname) {
    // "/" carries no information — fall through to a richer signal instead.
    if (after.pathname !== '/') return after.pathname;
    return after.search ? `${after.pathname}${after.search}` : null;
  }

  if (before.hash !== after.hash && after.hash.length > 1) return after.hash;
  if (before.search !== after.search && after.search.length > 1) return after.search;
  return null;
}

/**
 * Finds an element present after the action but not before, and returns a
 * verified locator for it. Prefers static text (banners, counters, headings)
 * over controls, since those are what actually evidence a state change.
 */
async function firstAppearedLocator(
  page: Page,
  before: PageSnapshot,
  after: PageSnapshot,
): Promise<Locator | null> {
  const key = (role: string, name: string) => `${role}|${name}`;
  const seen = new Set(before.elements.map((el) => key(el.role, el.accessibleName)));

  const appeared = after.elements.filter((el) => {
    if (seen.has(key(el.role, el.accessibleName))) return false;
    const name = el.accessibleName.trim();
    return name.length >= 2 && name.length <= 60;
  });

  const ranked = [
    ...appeared.filter((el) => !el.interactive),
    ...appeared.filter((el) => el.interactive),
  ];

  for (const element of ranked.slice(0, 5)) {
    const resolved = await resolveLocators(page, element);
    if (resolved) return resolved.primary;
  }
  return null;
}
