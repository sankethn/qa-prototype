import { chromium, type Browser, type Page } from 'playwright';

export interface LaunchOptions {
  headed?: boolean;
}

export async function launchBrowser({ headed = false }: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({ headless: !headed });
}

/**
 * Creates a page that is safe to run our `page.evaluate` callbacks on.
 *
 * tsx compiles with esbuild's `keepNames`, which wraps every function in a
 * `__name(...)` helper. That helper exists in the Node bundle but not in the
 * browser, so any evaluated callback dies with "__name is not defined". The
 * shim below restores it as an identity function, guarded so we never clobber
 * an app that ships its own esbuild helper.
 */
export async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    scope.__name ??= <T>(fn: T): T => fn;
  });
  return page;
}
