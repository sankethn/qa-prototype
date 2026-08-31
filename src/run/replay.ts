import type { Browser, Locator as PlaywrightLocator, Page } from 'playwright';
import type { Baseline, BaselineStep, Fingerprint, Locator } from '../baseline/types.js';
import { buildLocator, describeLocator } from '../browser/locator.js';
import { executeAction, isReadOnly, settle } from '../browser/execute.js';
import { launchBrowser, newPage } from '../browser/session.js';
import { resolveValueRef } from '../config.js';
import {
  classifyAppHealth,
  classifyExecutionError,
  classifyLocatorFailure,
  classifyNotReady,
  classifyOutcomeFailure,
  classifyPageDivergence,
} from './classify.js';
import { checkQuiescence } from '../browser/quiescence.js';
import { HealthMonitor } from './health.js';
import { verifyOutcome } from './verify.js';
import type { RunResult, StepFailure, StepResult } from './types.js';

/** Longest we keep retrying a missing element while the page still looks busy. */
const NOT_READY_BUDGET = 10_000;
/** Pause between retries while waiting for a busy page. */
const RETRY_INTERVAL = 300;

/**
 * Compares two URLs by shape, so a dynamic path segment does not read as a
 * divergence. `/orders/12345` and `/orders/67890` are the same page; `/home` and
 * `/login` are not. Query strings and hashes are ignored — they carry tracking
 * params and cache-busters that differ run to run.
 */
export function samePageShape(a: string, b: string): boolean {
  const shape = (raw: string): string | null => {
    try {
      const url = new URL(raw);
      const path = url.pathname
        .split('/')
        .map((segment) =>
          /^\d+$/.test(segment) ||
          /^[0-9a-f]{8,}$/i.test(segment) ||
          /^[0-9a-f-]{20,}$/i.test(segment)
            ? ':id'
            : segment,
        )
        .join('/');
      return `${url.origin}${path.replace(/\/$/, '')}`;
    } catch {
      return null;
    }
  };

  const left = shape(a);
  const right = shape(b);
  return left === null || right === null ? true : left === right;
}

export type RunEvent =
  | { type: 'step'; result: StepResult }
  | { type: 'skipped'; stepId: string }
  | { type: 'healing'; stepId: string }
  /** The heal could not be attempted. The step keeps its original failure. */
  | { type: 'healError'; stepId: string; message: string };

/**
 * Called when a step fails with a healable classification. Returning `healed`
 * lets the run continue; returning null fails the step normally.
 *
 * Injected as a callback rather than imported so the runner has no dependency
 * on the healing engine — replay stays usable, and testable, with no model
 * anywhere near it.
 */
export type HealHandler = (params: {
  page: Page;
  step: BaselineStep;
  failure: StepFailure;
  /**
   * Rebuilds pre-step state on a fresh page. Provided by the runner because only
   * it knows the preceding steps; the healer uses it between candidate attempts.
   */
  restore: () => Promise<Page>;
}) => Promise<{
  healed: boolean;
  locator: Locator;
  fallbacks: Locator[];
  fingerprint: Fingerprint;
  /** The page to continue on, if a restore replaced it. */
  page?: Page;
} | null>;

export interface ReplayOptions {
  baseline: Baseline;
  headed?: boolean;
  onEvent?: (event: RunEvent) => void;
  onHealableFailure?: HealHandler;
}

/**
 * Replays a stored baseline with no model in the loop.
 *
 * This is the fast path and the common case: on a healthy run nothing is sent
 * to an LLM at all, which is what makes the suite cheap enough to run often.
 * The model only re-enters at stage 4, and only for failures the classifier has
 * already judged to be stale locators.
 */
export async function replayBaseline({
  baseline,
  headed = false,
  onEvent,
  onHealableFailure,
}: ReplayOptions): Promise<RunResult> {
  const startedAt = new Date();
  const browser = await launchBrowser({ headed });

  try {
    // Mutable so a restore can swap in a fresh page mid-run. Created without
    // navigating: the first goto must happen inside the try below so that an
    // unreachable app comes back classified instead of as a raw throw.
    const context: RunContext = await openContext(browser);

    let steps: StepResult[];
    let failure: StepFailure | null = null;

    /**
     * Rebuilds the app state as it was before `index` on a brand new page, by
     * re-running the preceding steps. A fresh page rather than a reload: a new
     * Playwright page carries its own storage, so a half-completed login cannot
     * leak into the replay and change what the earlier steps do.
     */
    const restore: RestoreFn = async (index) => {
      const previous = context.page;
      const rebuilt = await openContext(browser);
      await startAt(rebuilt, baseline.startUrl);
      const prefix = await runSteps({
        context: rebuilt,
        steps: baseline.steps.slice(0, index),
      });
      if (prefix.some((r) => r.status !== 'passed')) {
        await rebuilt.page.close().catch(() => {});
        throw new Error(
          `Could not restore state before ${baseline.steps[index]?.stepId}: replaying the ` +
            'earlier steps failed. The application is no longer reproducible from the start.',
        );
      }
      context.page = rebuilt.page;
      context.monitor = rebuilt.monitor;
      await previous.close().catch(() => {});
      return rebuilt.page;
    };

    try {
      await startAt(context, baseline.startUrl);
      steps = await runSteps({
        context,
        steps: baseline.steps,
        onEvent,
        onHealableFailure,
        restore,
      });
    } catch (err) {
      // The app was never reachable, so no step ran. This must still come back as
      // a classified result rather than an exception — "the site is down" is the
      // most clear-cut not-healable failure there is, and swallowing it as a raw
      // throw would leave it unrecorded and unclassified.
      failure = classifyExecutionError(context.monitor.snapshot(), err);
      steps = baseline.steps.map((step) => {
        const skipped: StepResult = {
          stepId: step.stepId,
          action: step.action,
          status: 'skipped',
          durationMs: 0,
          locatorUsed: null,
          usedFallback: false,
          outcomeChecked: '',
          failure: null,
        };
        onEvent?.({ type: 'skipped', stepId: step.stepId });
        return skipped;
      });
    }

    return {
      runId: `${baseline.planId}-${startedAt.toISOString().replace(/[:.]/g, '-')}`,
      planId: baseline.planId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: failure || steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
      startUrl: baseline.startUrl,
      steps,
      failure,
    };
  } finally {
    await browser.close();
  }
}

/** The live page plus its health monitor. Mutable: a restore replaces both. */
export interface RunContext {
  page: Page;
  monitor: HealthMonitor;
}

/** Rebuilds state as it was before the step at `index`, returning the new page. */
export type RestoreFn = (index: number) => Promise<Page>;

async function openContext(browser: Browser): Promise<RunContext> {
  const page = await newPage(browser);
  return { page, monitor: new HealthMonitor(page) };
}

async function startAt(context: RunContext, startUrl: string): Promise<void> {
  await context.page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await settle(context.page);
}

export interface RunStepsParams {
  context: RunContext;
  steps: BaselineStep[];
  onEvent?: (event: RunEvent) => void;
  onHealableFailure?: HealHandler;
  restore?: RestoreFn;
}

/**
 * Executes steps in order, stopping at the first failure.
 *
 * Stopping is not just tidiness: once a step fails, the application is no longer
 * in the state later steps assume, so continuing would produce failures that say
 * nothing about the app. It is also why heal verification (stage 4) has to replay
 * from the start rather than retry in place — a wrong candidate leaves the page
 * somewhere the baseline never described.
 */
export async function runSteps({
  context,
  steps,
  onEvent,
  onHealableFailure,
  restore,
}: RunStepsParams): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let halted = false;

  for (const [index, step] of steps.entries()) {
    if (halted) {
      const skipped: StepResult = {
        stepId: step.stepId,
        action: step.action,
        status: 'skipped',
        durationMs: 0,
        locatorUsed: null,
        usedFallback: false,
        outcomeChecked: '',
        failure: null,
      };
      results.push(skipped);
      onEvent?.({ type: 'skipped', stepId: step.stepId });
      continue;
    }

    let result = await runStep(context.page, context.monitor, step);

    // Only a classified-healable failure is ever offered to the healer. Anything
    // the classifier attributed to the application is passed straight through.
    if (result.status === 'failed' && result.failure?.healable && onHealableFailure) {
      onEvent?.({ type: 'healing', stepId: step.stepId });

      // A healer that blows up — an API quota, a network blip, a restore that
      // could not rebuild state — must not become the step's verdict. The step
      // already has an honest classification; the heal simply did not happen.
      // Letting the error propagate would relabel a stale locator as an
      // application fault and discard the diagnosis we already had.
      let healed: Awaited<ReturnType<HealHandler>> = null;
      try {
        healed = await onHealableFailure({
          page: context.page,
          step,
          failure: result.failure,
          restore: restore
            ? () => restore(index)
            : () => Promise.reject(new Error('No restore available in this run.')),
        });
      } catch (err) {
        onEvent?.({
          type: 'healError',
          stepId: step.stepId,
          message: (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '',
        });
      }

      // The healer may have restored onto a different page part-way through.
      if (healed?.page) context.page = healed.page;

      const brokenAfterHeal = healed?.healed ? classifyAppHealth(context.monitor.snapshot()) : null;

      if (healed?.healed && !brokenAfterHeal) {
        // The healer already executed the step and verified the original outcome,
        // so the application is in the state the remaining steps expect.
        //
        // Applied to the in-memory step as well as reported: a later restore
        // replays these steps, and replaying them with the locator we just
        // proved stale would fail for a reason we already fixed.
        step.locator = healed.locator;
        step.fallbackLocators = healed.fallbacks;
        step.fingerprint = healed.fingerprint;

        result = {
          ...result,
          status: 'passed',
          failure: null,
          locatorUsed: healed.locator,
          outcomeChecked: result.outcomeChecked || 'verified after heal',
        };
      } else if (brokenAfterHeal) {
        // The candidate satisfied the assertion but left the app in a broken
        // state. Accepting that would bake a bad locator into the baseline.
        result = { ...result, failure: brokenAfterHeal };
      }
    }

    results.push(result);
    onEvent?.({ type: 'step', result });
    if (result.status === 'failed') halted = true;
  }

  return results;
}

async function runStep(
  page: Page,
  monitor: HealthMonitor,
  step: BaselineStep,
): Promise<StepResult> {
  monitor.beginStep();
  const startedAt = Date.now();

  const base = {
    stepId: step.stepId,
    action: step.action,
    durationMs: 0,
    locatorUsed: null as Locator | null,
    usedFallback: false,
    outcomeChecked: '',
  };
  const finish = (patch: Partial<StepResult>): StepResult =>
    ({ ...base, status: 'passed', failure: null, ...patch, durationMs: Date.now() - startedAt }) as StepResult;

  // Checked before the element is looked for. `navigate` is exempt: it goes to an
  // absolute URL and so does not care where the browser currently is.
  if (step.action !== 'navigate' && !samePageShape(step.pageUrl, page.url())) {
    return finish({
      status: 'failed',
      failure: classifyPageDivergence(monitor.snapshot(), step.pageUrl, page.url()),
    });
  }

  // Steps that act on the page rather than an element have no locator to resolve.
  const found = step.locator
    ? await findElement(page, step, monitor)
    : ({ locator: null, used: null, usedFallback: false } as const);

  if ('failure' in found) {
    return finish({
      status: 'failed',
      failure: found.busyReason
        ? classifyNotReady(monitor.snapshot(), found.busyReason, found.waitedMs)
        : classifyLocatorFailure(monitor.snapshot(), found.matchCount, found.detail),
    });
  }

  const value = step.valueRef ? resolveValueRef(step.valueRef) : step.value;

  try {
    await executeAction({ page, action: step.action, locator: found.locator, value });
  } catch (err) {
    return finish({
      status: 'failed',
      locatorUsed: found.used,
      usedFallback: found.usedFallback,
      failure: classifyExecutionError(monitor.snapshot(), err),
    });
  }

  if (!isReadOnly(step.action)) await settle(page);

  const verification = await verifyOutcome(page, step.expectedOutcome);
  if (!verification.ok) {
    return finish({
      status: 'failed',
      locatorUsed: found.used,
      usedFallback: found.usedFallback,
      outcomeChecked: verification.checked,
      failure: classifyOutcomeFailure(monitor.snapshot(), verification.detail),
    });
  }

  // The assertion held — but an assertion can hold on a broken page. A 500 error
  // page served at /checkout still satisfies urlContains "/checkout", so health
  // is checked on success too, not only on failure.
  const brokenAnyway = classifyAppHealth(monitor.snapshot());
  if (brokenAnyway) {
    return finish({
      status: 'failed',
      locatorUsed: found.used,
      usedFallback: found.usedFallback,
      outcomeChecked: verification.checked,
      failure: {
        ...brokenAnyway,
        message: `${brokenAnyway.message} The step's assertion (${verification.checked}) held regardless, which is why this is caught here rather than by the outcome check.`,
      },
    });
  }

  return finish({
    locatorUsed: found.used,
    usedFallback: found.usedFallback,
    outcomeChecked: verification.checked,
  });
}

interface FoundElement {
  locator: PlaywrightLocator | null;
  used: Locator | null;
  usedFallback: boolean;
}

interface NotFound {
  failure: true;
  matchCount: number;
  detail: string;
  /** Set when the page still looked busy — the element may simply not have arrived. */
  busyReason: string | null;
  waitedMs: number;
}

/**
 * Tries the primary locator, then each fallback in order, retrying while the
 * page still looks busy.
 *
 * The retry loop is not about patience, it is about attribution. A missing
 * element on a settled page is a stale locator and worth healing; a missing
 * element on a page that is still fetching and rendering is a timeout. Without
 * this distinction, a slow API turns into a heal attempt against loading
 * skeletons — and a healer given skeletons will find one that looks plausible.
 *
 * So the loop exits the moment the page looks settled, however little time has
 * passed, and only keeps waiting while there is positive evidence of work.
 *
 * A fallback rescuing the step is reported rather than silently accepted: the
 * test still passes, but the baseline has drifted and is one more change away
 * from needing a heal.
 */
export async function findElement(
  page: Page,
  step: BaselineStep,
  monitor?: HealthMonitor,
): Promise<FoundElement | NotFound> {
  const primary = step.locator;
  if (!primary) return { locator: null, used: null, usedFallback: false };

  const candidates = [primary, ...step.fallbackLocators];
  const startedAt = Date.now();
  let primaryCount = 0;
  let busy: { busy: boolean; reason: string | null } = { busy: false, reason: null };

  for (;;) {
    for (const [index, candidate] of candidates.entries()) {
      const count = await countOf(page, candidate);
      if (index === 0) primaryCount = count;

      const matched = candidate.nth === null ? count === 1 : count > candidate.nth;
      if (matched) {
        return {
          locator: buildLocator(page, candidate),
          used: candidate,
          usedFallback: index > 0,
        };
      }
    }

    const waited = Date.now() - startedAt;
    if (waited >= NOT_READY_BUDGET) break;

    busy = await checkQuiescence(page, {
      inFlightRequests: monitor?.snapshot().inFlightRequests ?? 0,
    }).catch(() => ({ busy: false, reason: null }));

    // Settled and still missing: the locator is genuinely stale. Stop straight
    // away rather than burning the whole budget on a page that will not change.
    if (!busy.busy) break;

    await page.waitForTimeout(RETRY_INTERVAL);
  }

  const tried = candidates.map(describeLocator).join(', ');
  const print = step.fingerprint;
  const was = print
    ? ` Baseline recorded a ${print.role}${print.accessibleName ? ` named "${print.accessibleName}"` : ''}${print.context ? ` in "${print.context}"` : ''}.`
    : '';
  return {
    failure: true,
    matchCount: primaryCount,
    detail: `Tried: ${tried}.${was}`,
    busyReason: busy.busy ? busy.reason : null,
    waitedMs: Date.now() - startedAt,
  };
}

/** Counts matches for a candidate, ignoring its own nth so ambiguity is visible. */
async function countOf(page: Page, candidate: Locator): Promise<number> {
  return buildLocator(page, { ...candidate, nth: null })
    .count()
    .catch(() => 0);
}
