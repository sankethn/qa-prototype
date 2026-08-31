import type { Page, Request } from 'playwright';
import type { AppHealth } from './types.js';

/**
 * Uncaught errors that say nothing about application health. Everything else is
 * treated as a real fault, because a framework that renders server errors on the
 * client may leave no HTTP signal at all — a Next.js server component throwing
 * arrives as an RSC payload with status 200 and an uncaught exception in the
 * browser. Ignoring page errors would mean that failure has no signal whatsoever.
 */
const BENIGN_PAGE_ERRORS: RegExp[] = [
  /ResizeObserver loop/i,
  /Non-Error promise rejection captured/i,
];

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
  private serverErrors: string[] = [];
  private pageErrors: string[] = [];
  /**
   * Same-origin requests we have seen start but not finish. Tracked ourselves
   * rather than relying on `networkidle`, which never settles on an app that
   * polls or holds a long-lived connection, and which cannot be told to ignore
   * a heartbeat we know is noise.
   */
  private readonly inFlight = new Set<Request>();

  constructor(private readonly page: Page) {
    page.on('response', (response) => {
      const request = response.request();
      const isMainDocument =
        request.resourceType() === 'document' && request.frame() === page.mainFrame();

      if (isMainDocument) {
        this.documentStatus = response.status();
        return;
      }

      // A client-side navigation produces no document response, so a server
      // failure during one is only visible here. Restricted to 5xx and to the
      // app's own origin: a 4xx sub-request is often routine (an optional
      // resource, an auth probe) and a third-party 500 is not our app breaking.
      if (response.status() >= 500 && this.isSameOrigin(response.url())) {
        this.serverErrors.push(`${request.method()} ${response.url()} — ${response.status()}`);
      }
    });

    page.on('request', (request) => {
      if (this.isSameOrigin(request.url())) this.inFlight.add(request);
    });

    const settled = (request: Request) => this.inFlight.delete(request);
    page.on('requestfinished', settled);

    page.on('requestfailed', (request) => {
      settled(request);
      const failure = request.failure()?.errorText ?? 'failed';
      // Cancelled requests are routine during navigation, not a fault signal.
      if (failure.includes('ERR_ABORTED')) return;
      this.failedRequests.push(`${request.method()} ${request.url()} — ${failure}`);
    });

    page.on('pageerror', (error) => {
      const message = error.message.split('\n')[0] ?? error.message;
      if (BENIGN_PAGE_ERRORS.some((pattern) => pattern.test(message))) return;
      this.pageErrors.push(message);
    });

    page.on('crash', () => {
      this.crashed = true;
    });
  }

  /** Clears per-step signals so a failure is attributed to the step that caused it. */
  beginStep(): void {
    this.failedRequests = [];
    this.serverErrors = [];
    this.pageErrors = [];
  }

  snapshot(): AppHealth {
    return {
      documentStatus: this.documentStatus,
      crashed: this.crashed,
      failedRequests: [...this.failedRequests],
      serverErrors: [...this.serverErrors],
      pageErrors: [...this.pageErrors],
      inFlightRequests: this.inFlight.size,
    };
  }

  private isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.page.url()).origin;
    } catch {
      return false;
    }
  }

  /**
   * True when the application is visibly broken. Checked BEFORE any locator
   * reasoning — ordering is the whole point, since a broken app also makes
   * elements disappear.
   */
  static isAppBroken(health: AppHealth): boolean {
    if (health.crashed) return true;
    if (health.documentStatus !== null && health.documentStatus >= 400) return true;
    if (health.serverErrors.length > 0) return true;
    if (health.failedRequests.length > 0) return true;
    if (health.pageErrors.length > 0) return true;
    return false;
  }
}
