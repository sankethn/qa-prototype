import type { Locator as PlaywrightLocator, Page } from 'playwright';
import type { Action } from '../intent/types.js';

export const DEFAULT_TIMEOUT = 8000;

/**
 * Lets an SPA finish reacting before we look at the page again. `networkidle`
 * alone is unreliable on apps that poll, so it is raced against a short ceiling
 * rather than awaited outright.
 */
export async function settle(page: Page, quietMs = 400): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(quietMs);
}

export interface ExecuteParams {
  page: Page;
  action: Action;
  locator: PlaywrightLocator | null;
  /** Already resolved from valueRef — never a secret name, always the real value. */
  value: string | null;
}

/**
 * Performs one action. `assert` and `waitFor` only observe: they must never
 * mutate application state, or a verification step would become a side effect.
 */
export async function executeAction({
  page,
  action,
  locator,
  value,
}: ExecuteParams): Promise<void> {
  const options = { timeout: DEFAULT_TIMEOUT };

  switch (action) {
    case 'navigate':
      await page.goto(value ?? '', { timeout: DEFAULT_TIMEOUT });
      return;

    case 'assert':
    case 'waitFor':
      await requireLocator(locator, action).waitFor({ state: 'visible', ...options });
      return;

    case 'click':
      await requireLocator(locator, action).click(options);
      return;

    case 'fill':
      await requireLocator(locator, action).fill(value ?? '', options);
      return;

    case 'select':
      await requireLocator(locator, action).selectOption(value ?? '', options);
      return;

    case 'check':
      await requireLocator(locator, action).check(options);
      return;

    case 'uncheck':
      await requireLocator(locator, action).uncheck(options);
      return;

    case 'hover':
      await requireLocator(locator, action).hover(options);
      return;

    case 'press':
      if (locator) await locator.press(value ?? '', options);
      else await page.keyboard.press(value ?? '');
      return;
  }
}

/** True for actions that only observe — used to decide whether state advanced. */
export function isReadOnly(action: Action): boolean {
  return action === 'assert' || action === 'waitFor' || action === 'hover';
}

function requireLocator(locator: PlaywrightLocator | null, action: Action): PlaywrightLocator {
  if (!locator) throw new Error(`Action "${action}" requires a resolved element.`);
  return locator;
}
