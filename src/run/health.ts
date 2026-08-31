import type { Page } from 'playwright';
import type { AppHealth } from './types.js';

/**
 * Watches the page for signs that the application itself is broken, so the
 * classifier can tell "the button moved" from "the server is down".
 *
 * Without this, a 500 that empties the page looks exactly like a renamed
 * element: the locator matches nothing either way. Healing on that signal
 * would rewrite a perfectly good test to chase a broken deploy.
 */
export class HealthMonitor {
  private documentStatus: number | null = null;
  private crashed = false;
  private failedRequests: string[] = [];
  private pageErrors: string[] = [];

  constructor(private readonly page: Page) {
    page.on('response', (response) => {
      const request = response.request();
      if (request.resourceType() !== 'document') return;
      if (request.frame() !== page.mainFrame()) return;
      this.documentStatus = response.status();
    });

    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? 'failed';
      // Cancelled requests are routine during navigation, not a fault signal.
      if (failure.includes('ERR_ABORTED')) return;
      this.failedRequests.push(`${request.method()} ${request.url()} — ${failure}`);
    });

    page.on('pageerror', (error) => {
      this.pageErrors.push(error.message.split('\n')[0] ?? error.message);
    });

    page.on('crash', () => {
      this.crashed = true;
    });
  }

  /** Clears per-step signals so a failure is attributed to the step that caused it. */
  beginStep(): void {
    this.failedRequests = [];
    this.pageErrors = [];
  }

  snapshot(): AppHealth {
    return {
      documentStatus: this.documentStatus,
      crashed: this.crashed,
      failedRequests: [...this.failedRequests],
      pageErrors: [...this.pageErrors],
    };
  }

  /**
   * True when the application is visibly broken. Checked BEFORE any locator
   * reasoning — ordering is the whole point, since a broken app also makes
   * elements disappear.
   */
  static isAppBroken(health: AppHealth): boolean {
    if (health.crashed) return true;
    if (health.documentStatus !== null && health.documentStatus >= 400) return true;
    if (health.failedRequests.length > 0) return true;
    return false;
  }
}
