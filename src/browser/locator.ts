import type { Locator as PlaywrightLocator, Page } from 'playwright';
import type { Locator } from '../baseline/types.js';
import { REF_ATTRIBUTE, type ExtractedElement } from './extract.js';

const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** Turns a stored locator record into a live Playwright locator. */
export function buildLocator(page: Page, locator: Locator): PlaywrightLocator {
  const resolved = resolveStrategy(page, locator);
  return locator.nth === null ? resolved : resolved.nth(locator.nth);
}

function resolveStrategy(page: Page, locator: Locator): PlaywrightLocator {
  const value = locator.value ?? '';

  switch (locator.strategy) {
    case 'testId':
      // Matched against every known test-id attribute, since apps disagree on which.
      return page.locator(TEST_ID_ATTRS.map((a) => `[${a}="${cssEscape(value)}"]`).join(','));
    case 'role':
      return page.getByRole(locator.role as Parameters<Page['getByRole']>[0], {
        ...(locator.name ? { name: locator.name, exact: true } : {}),
      });
    case 'label':
      return page.getByLabel(value, { exact: true });
    case 'placeholder':
      return page.getByPlaceholder(value, { exact: true });
    case 'altText':
      return page.getByAltText(value, { exact: true });
    case 'text':
      return page.getByText(value, { exact: true });
    case 'css':
      return page.locator(value);
  }
}

export function describeLocator(locator: Locator): string {
  const base =
    locator.strategy === 'role'
      ? `role=${locator.role}[name="${locator.name ?? ''}"]`
      : `${locator.strategy}="${locator.value ?? ''}"`;
  return locator.nth === null ? base : `${base} >> nth=${locator.nth}`;
}

/**
 * Candidate locators for an element, most durable first.
 *
 * The ordering is the whole point: a test id survives a redesign, an accessible
 * name usually survives a restyle, and visible text is the first thing a copy
 * change breaks. Anything derived from DOM position is deliberately absent —
 * a locator we cannot explain is a locator we cannot heal.
 */
export function deriveLocatorCandidates(element: ExtractedElement): Locator[] {
  const candidates: Locator[] = [];
  const add = (locator: Omit<Locator, 'nth'>) => candidates.push({ ...locator, nth: null });

  if (element.testId) {
    add({ strategy: 'testId', value: element.testId, role: null, name: null });
  }
  if (element.accessibleName) {
    add({ strategy: 'role', value: null, role: element.role, name: element.accessibleName });
  }
  if (element.labelText) {
    add({ strategy: 'label', value: element.labelText, role: null, name: null });
  }
  if (element.placeholder) {
    add({ strategy: 'placeholder', value: element.placeholder, role: null, name: null });
  }
  if (element.altText) {
    add({ strategy: 'altText', value: element.altText, role: null, name: null });
  }
  if (element.id) {
    add({ strategy: 'css', value: `#${CSS_ID_SAFE.test(element.id) ? element.id : cssEscape(element.id)}`, role: null, name: null });
  }
  if (element.nameAttr) {
    add({
      strategy: 'css',
      value: `${element.tagName}[name="${cssEscape(element.nameAttr)}"]`,
      role: null,
      name: null,
    });
  }
  // Kept even when the text equals the accessible name. The two look redundant but
  // fail under different conditions: a rename breaks both (correctly a healing case),
  // while a <button> refactored into an <a> breaks only the role locator. That
  // refactor is common enough that the text locator earns its place.
  if (element.text && element.text.length <= 60) {
    add({ strategy: 'text', value: element.text, role: null, name: null });
  }

  return candidates;
}

const CSS_ID_SAFE = /^[A-Za-z][\w-]*$/;

export interface ResolvedLocators {
  primary: Locator;
  fallbacks: Locator[];
}

/**
 * Verifies each candidate against the live page and keeps only those that
 * actually resolve back to the element the model chose.
 *
 * This is the "Playwright verifies" half applied at baseline time: a locator is
 * never written to a baseline on the strength of looking plausible, only after
 * it has been proven to select this exact element and nothing else.
 */
export async function resolveLocators(
  page: Page,
  element: ExtractedElement,
): Promise<ResolvedLocators | null> {
  const candidates = deriveLocatorCandidates(element);
  const verified: Locator[] = [];

  for (const candidate of candidates) {
    const locator = buildLocator(page, candidate);
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;

    if (count === 1) {
      if (await matchesRef(locator, element.ref)) verified.push(candidate);
      continue;
    }

    // Ambiguous on its own. Usable only if our element sits at a known index —
    // "the first product card" is a legitimate test, "some div" is not.
    const index = await indexOfRef(locator, count, element.ref);
    if (index !== null) verified.push({ ...candidate, nth: index });
  }

  const [primary, ...fallbacks] = verified;
  return primary ? { primary, fallbacks } : null;
}

async function matchesRef(locator: PlaywrightLocator, ref: string): Promise<boolean> {
  const found = await locator
    .getAttribute(REF_ATTRIBUTE, { timeout: 2000 })
    .catch(() => null);
  return found === ref;
}

async function indexOfRef(
  locator: PlaywrightLocator,
  count: number,
  ref: string,
  maxScan = 20,
): Promise<number | null> {
  for (let i = 0; i < Math.min(count, maxScan); i++) {
    if (await matchesRef(locator.nth(i), ref)) return i;
  }
  return null;
}
