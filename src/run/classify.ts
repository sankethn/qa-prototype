import { HealthMonitor } from './health.js';
import { isHealable, type AppHealth, type FailureKind, type StepFailure } from './types.js';

function failure(kind: FailureKind, message: string, health: AppHealth): StepFailure {
  return { kind, healable: isHealable(kind), message, health };
}

/**
 * Every classification starts here. A broken application also makes elements
 * vanish, so app health is checked before any locator reasoning — otherwise a
 * 500 would be diagnosed as a renamed button and "healed" into a green test.
 *
 * Also run after a step *succeeds*: an assertion can hold on a broken page.
 * `urlContains "/checkout"` is perfectly true of a 500 error page served at
 * /checkout, and reporting that as green is worse than a false red.
 *
 * Any 4xx counts too. A 404 means the route is gone and a 401/403 means the
 * session is not what the test assumed — neither is a stale locator, and both
 * would otherwise present as missing elements and invite a heal.
 */
export function classifyAppHealth(health: AppHealth): StepFailure | null {
  if (health.crashed) {
    return failure('PAGE_CRASH', 'The browser page crashed.', health);
  }
  if (health.documentStatus !== null && health.documentStatus >= 400) {
    return failure('HTTP_ERROR', `Server returned HTTP ${health.documentStatus}.`, health);
  }
  if (health.serverErrors.length > 0) {
    return failure('HTTP_ERROR', `Server error during this step: ${health.serverErrors[0]}`, health);
  }
  if (health.failedRequests.length > 0) {
    return failure(
      'NETWORK_ERROR',
      `Request failed: ${health.failedRequests[0]}`,
      health,
    );
  }
  // Last, because it is the least specific signal — but still a signal. A
  // framework that renders server errors on the client leaves no status code
  // behind, so this is sometimes the only evidence that anything went wrong.
  if (health.pageErrors.length > 0) {
    return failure(
      'PAGE_ERROR',
      `Uncaught error in the application: ${health.pageErrors[0]}`,
      health,
    );
  }
  return null;
}

const appFault = classifyAppHealth;

/**
 * The browser is not on the page this step was recorded against.
 *
 * Never healable, and it must be checked before the element is even looked for.
 * An expired session that bounced us to /login, an unexpected redirect, or a
 * feature flag serving a different route all make every element "missing" — and
 * a healer pointed at a login screen will find a plausible input field and
 * rewrite the test to match it.
 */
export function classifyPageDivergence(
  health: AppHealth,
  expectedUrl: string,
  actualUrl: string,
): StepFailure {
  const broken = appFault(health);
  if (broken) return broken;

  return failure(
    'PAGE_DIVERGED',
    `This step was recorded on ${expectedUrl} but the browser is on ${actualUrl}. ` +
      'The application is not in the state the step expects — commonly an expired ' +
      'session, a redirect, or an earlier step ending somewhere unintended.',
    health,
  );
}

/**
 * The element is missing, but the page has not finished working.
 *
 * Never healable. This is the distinction that keeps the healer away from
 * loading states: a slow API is not a renamed button, and a page of skeletons
 * is not a page whose controls have moved.
 */
export function classifyNotReady(health: AppHealth, reason: string, waitedMs: number): StepFailure {
  const broken = appFault(health);
  if (broken) return broken;

  return failure(
    'PAGE_NOT_READY',
    `The element did not appear within ${waitedMs}ms and the page is still busy: ${reason}. ` +
      'Treated as a timeout rather than a stale locator — the element may yet arrive.',
    health,
  );
}

/** The element could not be located. The only genuinely healable situation. */
export function classifyLocatorFailure(
  health: AppHealth,
  matchCount: number,
  detail: string,
): StepFailure {
  const broken = appFault(health);
  if (broken) return broken;

  if (matchCount > 1) {
    return failure(
      'LOCATOR_AMBIGUOUS',
      `Locator matched ${matchCount} elements but was unique when the baseline was recorded. ${detail}`,
      health,
    );
  }

  return failure(
    'ELEMENT_NOT_FOUND',
    `No element matched. ${detail}`,
    health,
  );
}

/**
 * The element was found but acting on it threw. Not healable: a locator that
 * still resolves is not a stale locator, so whatever went wrong is the app's
 * behaviour — a disabled control, a modal in the way, a hung request.
 */
export function classifyExecutionError(health: AppHealth, error: unknown): StepFailure {
  const broken = appFault(health);
  if (broken) return broken;

  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

  if (/net::ERR_|NS_ERROR_|ERR_CONNECTION/.test(message)) {
    return failure('NETWORK_ERROR', message, health);
  }
  if (/navigation|goto|net::/i.test(message) && /fail|abort/i.test(message)) {
    return failure('NAVIGATION_FAILED', message, health);
  }
  if (/not enabled|intercepts pointer events|not visible|not stable|not editable/i.test(message)) {
    return failure(
      'ELEMENT_NOT_INTERACTABLE',
      `The element was found but could not be acted on: ${message}`,
      health,
    );
  }

  return failure('STEP_ERROR', message, health);
}

/**
 * The step ran, but the application did not end up in the expected state.
 *
 * Never healable, and this is the case that matters most. A failed login lands
 * here: the sign-in button was found and clicked perfectly well, the app simply
 * did not authenticate. Healing would hunt for a "better" button to make the
 * assertion pass and bury a real auth regression.
 */
export function classifyOutcomeFailure(health: AppHealth, detail: string): StepFailure {
  const broken = appFault(health);
  if (broken) return broken;

  const errors = health.pageErrors.length > 0 ? ` Page errors: ${health.pageErrors[0]}` : '';
  return failure(
    'OUTCOME_NOT_MET',
    `The step executed but its expected outcome did not hold. ${detail}${errors}`,
    health,
  );
}

export { HealthMonitor };
