import type { Page } from 'playwright';

/**
 * Decides whether a page is still working or has finished.
 *
 * This exists to answer one question correctly: when an element is missing, is
 * it missing because the test is stale, or because the app has not finished
 * rendering? Getting that wrong is the most dangerous mistake the system can
 * make — a healer handed a page of loading skeletons will happily propose one.
 *
 * `networkidle` cannot answer it. It never settles on an app that polls or holds
 * a long-lived connection, it can be reached before React has rendered the
 * response, and a fetch fired from an effect starts *after* it. So this combines
 * several weaker signals instead of trusting one.
 *
 * It is a heuristic, and it is meant to be: a bare skeleton with no ARIA and no
 * recognisable class name will still look settled. The goal is to convert the
 * common case from silently-wrong to correctly-attributed.
 */

/** Class-name fragments that conventionally mark placeholder content. */
const LOADING_CLASS_PATTERN = /(^|[-_ ])(skeleton|shimmer|placeholder|loading|spinner|busy)([-_ ]|$)/i;

export interface BusySignal {
  busy: boolean;
  reason: string | null;
}

/**
 * In-page indicators that the app has told us it is not ready. Everything here
 * is either a standard (`aria-busy`, `role=progressbar`, `<progress>`) or a
 * widespread convention (skeleton/spinner class names).
 */
async function inPageBusyReason(page: Page): Promise<string | null> {
  return page.evaluate(({ loadingPattern }) => {
    const pattern = new RegExp(loadingPattern.source, loadingPattern.flags);

    const visible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    if (document.readyState !== 'complete') return `document.readyState is ${document.readyState}`;

    for (const el of Array.from(document.querySelectorAll('[aria-busy="true"]'))) {
      if (visible(el)) return 'an element is marked aria-busy';
    }

    for (const el of Array.from(document.querySelectorAll('[role="progressbar"],progress'))) {
      if (visible(el)) return 'a progress indicator is showing';
    }

    for (const el of Array.from(document.querySelectorAll('[class]'))) {
      const className = typeof el.className === 'string' ? el.className : '';
      if (pattern.test(className) && visible(el)) {
        return `a loading placeholder is showing (class "${className.slice(0, 60)}")`;
      }
    }

    return null;
  }, { loadingPattern: { source: LOADING_CLASS_PATTERN.source, flags: LOADING_CLASS_PATTERN.flags } });
}

/**
 * Cheap structural signature. Compared across a short interval to tell a page
 * that is still rendering from one that has stopped — which catches frameworks
 * that render in several passes after the network has gone quiet.
 */
async function domSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const body = document.body;
    return `${document.querySelectorAll('*').length}:${(body?.innerText.length ?? 0)}`;
  });
}

export interface QuiescenceOptions {
  /** Same-origin requests currently outstanding, from the health monitor. */
  inFlightRequests: number;
  /** Interval used to judge DOM stability. */
  stabilityMs?: number;
}

/**
 * Returns why the page looks busy, or `{ busy: false }` if it looks settled.
 *
 * Checked in increasing cost order: an in-flight request or an explicit busy
 * marker is conclusive, so the DOM-stability comparison — the only check that
 * costs real time — runs last and only when the cheaper ones came back clean.
 */
export async function checkQuiescence(
  page: Page,
  { inFlightRequests, stabilityMs = 250 }: QuiescenceOptions,
): Promise<BusySignal> {
  if (inFlightRequests > 0) {
    return { busy: true, reason: `${inFlightRequests} request(s) still in flight` };
  }

  const marker = await inPageBusyReason(page).catch(() => null);
  if (marker) return { busy: true, reason: marker };

  const before = await domSignature(page).catch(() => null);
  if (before === null) return { busy: false, reason: null };
  await page.waitForTimeout(stabilityMs);
  const after = await domSignature(page).catch(() => null);

  if (after !== null && after !== before) {
    return { busy: true, reason: 'the DOM is still changing' };
  }

  return { busy: false, reason: null };
}
