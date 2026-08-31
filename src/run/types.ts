import { z } from 'zod';
import { ACTIONS } from '../intent/types.js';
import { locatorSchema } from '../baseline/types.js';

/**
 * Why a step failed.
 *
 * The split that matters is not how severe the failure looked, but whether the
 * TEST is stale or the APP is wrong:
 *
 *   - We could not FIND the element      -> the test is stale       -> healable
 *   - We acted, but the OUTCOME failed   -> the app misbehaved      -> never heal
 *   - The app itself is unhealthy        -> nothing to heal         -> never heal
 *
 * Healing a failure of the second or third kind would silently paper over the
 * exact bug the suite exists to catch, so the classifier is deliberately
 * conservative: anything it cannot confidently attribute to a stale locator is
 * left alone.
 */
export const FAILURE_KINDS = [
  // Stale-test failures. Healable.
  'ELEMENT_NOT_FOUND',
  'LOCATOR_AMBIGUOUS',

  // Real application failures. Never healable.
  'OUTCOME_NOT_MET',
  'ELEMENT_NOT_INTERACTABLE',
  'HTTP_ERROR',
  'PAGE_CRASH',
  'NETWORK_ERROR',
  'NAVIGATION_FAILED',
  'STEP_ERROR',
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** The single source of truth for what may be healed. */
export const HEALABLE_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'ELEMENT_NOT_FOUND',
  'LOCATOR_AMBIGUOUS',
]);

export function isHealable(kind: FailureKind): boolean {
  return HEALABLE_KINDS.has(kind);
}

export const appHealthSchema = z.object({
  /** Status of the most recent main-frame document response. */
  documentStatus: z.number().nullable(),
  crashed: z.boolean(),
  failedRequests: z.array(z.string()),
  pageErrors: z.array(z.string()),
});

export type AppHealth = z.infer<typeof appHealthSchema>;

export const failureSchema = z.object({
  kind: z.enum(FAILURE_KINDS),
  healable: z.boolean(),
  message: z.string(),
  /** What the classifier saw. Kept so a wrong call can be argued with later. */
  health: appHealthSchema,
});

export type StepFailure = z.infer<typeof failureSchema>;

export const stepResultSchema = z.object({
  stepId: z.string(),
  action: z.enum(ACTIONS),
  status: z.enum(['passed', 'failed', 'skipped']),
  durationMs: z.number(),
  /** Which locator actually worked — null when none did. */
  locatorUsed: locatorSchema.nullable(),
  /**
   * Set when the primary locator failed but a fallback succeeded. The step passed,
   * but the baseline has drifted and is one change away from needing a heal.
   */
  usedFallback: z.boolean(),
  outcomeChecked: z.string(),
  failure: failureSchema.nullable(),
});

export type StepResult = z.infer<typeof stepResultSchema>;

export const runResultSchema = z.object({
  runId: z.string(),
  planId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  status: z.enum(['passed', 'failed']),
  startUrl: z.string(),
  steps: z.array(stepResultSchema),
  /**
   * Set when the run failed before any step could execute — the app was
   * unreachable, or the start URL would not load. Distinct from a step failure:
   * nothing was tested, so nothing can be concluded about the test itself.
   */
  failure: failureSchema.nullable(),
});

export type RunResult = z.infer<typeof runResultSchema>;
