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
  if (health.failedRequests.length > 0) {
    return failure(
      'NETWORK_ERROR',
      `Request failed: ${health.failedRequests[0]}`,
      health,
    );
  }
  return null;
}

const appFault = classifyAppHealth;

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
