import type { Page } from 'playwright';
import type { BaselineStep, Fingerprint, Locator } from '../baseline/types.js';
import { extractPage } from '../browser/extract.js';
import { toFingerprint } from '../browser/fingerprint.js';
import { executeAction, isReadOnly, settle } from '../browser/execute.js';
import { buildLocator, resolveLocators } from '../browser/locator.js';
import { resolveValueRef } from '../config.js';
import { verifyOutcome } from '../run/verify.js';
import { proposeHeal } from './propose.js';
import type { HealAttempt, HealCandidate, HealRecord } from './types.js';

/**
 * Confidence below this and the candidate is never executed.
 *
 * The gate is an admission filter, not proof. A high score does not make a
 * candidate correct — it only makes it worth spending a real execution on.
 * Correctness is decided afterwards, by the page.
 */
export const HEAL_THRESHOLD = 0.85;

export interface HealParams {
  page: Page;
  step: BaselineStep;
  failureMessage: string;
  threshold?: number;
  /** Upper bound on candidates actually executed, regardless of how many are proposed. */
  maxAttempts?: number;
  /**
   * Rebuilds the application state as it was immediately before this step, on a
   * fresh page, and returns that page.
   *
   * Required to try more than one candidate. Executing a wrong candidate leaves
   * the app somewhere the baseline never described, so a second attempt from
   * there would be testing nothing. Without a restore, exactly one candidate is
   * tried and the rest are reported as untried.
   */
  restore?: () => Promise<Page>;
}

/** The change to write back into the baseline once a heal is accepted. */
export interface HealUpdate {
  locator: Locator;
  fallbacks: Locator[];
  /**
   * The healed element as it looks now. Written alongside the locator so the
   * next heal reasons about the element that actually exists — a fingerprint
   * left describing the pre-heal element would go one generation staler with
   * every repair.
   */
  fingerprint: Fingerprint;
  record: HealRecord;
}

export interface HealOutcome {
  attempt: HealAttempt;
  /** Set only when the heal was accepted. */
  update: HealUpdate | null;
  /** The page to continue on — a different one if a restore happened. */
  page: Page;
}

/**
 * Proposes a replacement element, and accepts it only if the page agrees.
 *
 * The sequence is the whole design:
 *
 *   model proposes  ->  confidence gate  ->  Playwright executes
 *                                        ->  ORIGINAL outcome is verified
 *                                        ->  accepted or rejected
 *
 * The outcome checked is the one recorded in the baseline, never a new one the
 * model suggests. Letting the model supply both the candidate and the standard
 * it is judged against would make healing self-certifying, and the test would
 * drift to whatever the model believes rather than what the app must do.
 */
export async function attemptHeal({
  page,
  step,
  failureMessage,
  threshold = HEAL_THRESHOLD,
  maxAttempts = 3,
  restore,
}: HealParams): Promise<HealOutcome> {
  // A step with no element has nothing to heal. Reaching here would mean the
  // classifier blamed a locator on a step that never had one.
  const previousLocator = step.locator;
  const previousFingerprint = step.fingerprint;
  if (!previousLocator || !previousFingerprint) {
    throw new Error(
      `Step ${step.stepId} (${step.action}) acts on no element and cannot be healed.`,
    );
  }

  const snapshot = await extractPage(page);
  const { proposal, model } = await proposeHeal({ step, snapshot, failureMessage });
  const proposed = proposal.candidates;

  const base = {
    stepId: step.stepId,
    threshold,
    model,
    previousLocator,
    candidatesProposed: proposed.length,
  };
  const done = (
    fields: Omit<HealAttempt, keyof typeof base>,
    update: HealUpdate | null = null,
    currentPage: Page = page,
  ): HealOutcome => ({ attempt: { ...base, ...fields }, update, page: currentPage });

  if (proposed.length === 0) {
    return done({
      status: 'no_candidate',
      confidence: 0,
      reason: proposal.reason,
      newLocator: null,
      candidatesTried: 0,
      verification: 'The model found no element serving the original intent.',
    });
  }

  const best = proposed[0]!;
  const admitted = proposed.filter((c) => c.confidence >= threshold);

  if (admitted.length === 0) {
    return done({
      status: 'below_threshold',
      confidence: best.confidence,
      reason: best.reason,
      newLocator: null,
      candidatesTried: 0,
      verification: `Best candidate scored ${best.confidence.toFixed(2)}, below the ${threshold} gate; nothing was executed.`,
    });
  }

  // Locators are derived from the failure-time page, before anything is clicked.
  // Once a candidate has been executed the page has moved on, so a later
  // candidate could no longer be resolved against the state that produced it.
  const resolvedCandidates: Array<{ candidate: HealCandidate; update: HealUpdate }> = [];
  for (const candidate of admitted.slice(0, maxAttempts)) {
    const element = snapshot.elements.find((el) => el.ref === candidate.ref);
    if (!element) continue;
    const locators = await resolveLocators(page, element);
    if (!locators) continue;
    resolvedCandidates.push({
      candidate,
      update: {
        locator: locators.primary,
        fallbacks: locators.fallbacks,
        fingerprint: toFingerprint(element),
        record: {
          healedAt: new Date().toISOString(),
          confidence: candidate.confidence,
          reason: candidate.reason,
          model,
          previousLocator,
          previousFingerprint,
        },
      },
    });
  }

  if (resolvedCandidates.length === 0) {
    return done({
      status: 'unlocatable',
      confidence: best.confidence,
      reason: best.reason,
      newLocator: null,
      candidatesTried: 0,
      verification: 'No proposed candidate had an attribute stable enough to locate it uniquely.',
    });
  }

  const value = step.valueRef ? resolveValueRef(step.valueRef) : step.value;
  let currentPage = page;
  let tried = 0;
  const rejections: string[] = [];

  for (const [index, { candidate, update }] of resolvedCandidates.entries()) {
    if (index > 0) {
      // The previous candidate already acted on the app. Without a restore there
      // is no honest state left to try another one against, so we stop rather
      // than test against a page the baseline never described.
      if (!restore) break;
      currentPage = await restore();
      const stillThere = await buildLocator(currentPage, update.locator)
        .count()
        .catch(() => 0);
      if (stillThere !== 1) {
        rejections.push(`${describeCandidate(candidate)}: no longer uniquely present after restore`);
        continue;
      }
    }

    tried++;

    try {
      await executeAction({
        page: currentPage,
        action: step.action,
        locator: buildLocator(currentPage, update.locator),
        value,
      });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
      rejections.push(`${describeCandidate(candidate)}: ${message}`);
      if (index === resolvedCandidates.length - 1 || !restore) {
        return done(
          {
            status: 'execution_failed',
            confidence: candidate.confidence,
            reason: candidate.reason,
            newLocator: update.locator,
            candidatesTried: tried,
            verification: rejections.join(' | '),
          },
          null,
          currentPage,
        );
      }
      continue;
    }

    if (!isReadOnly(step.action)) await settle(currentPage);

    const verification = await verifyOutcome(currentPage, step.expectedOutcome);
    if (verification.ok) {
      return done(
        {
          status: 'accepted',
          confidence: candidate.confidence,
          reason: candidate.reason,
          newLocator: update.locator,
          candidatesTried: tried,
          verification: `${verification.checked} held after executing the candidate.`,
        },
        update,
        currentPage,
      );
    }

    rejections.push(`${describeCandidate(candidate)}: ${verification.detail}`);
  }

  const untried = resolvedCandidates.length - tried;
  return done(
    {
      status: 'rejected',
      confidence: best.confidence,
      reason: best.reason,
      newLocator: resolvedCandidates[0]!.update.locator,
      candidatesTried: tried,
      verification:
        rejections.join(' | ') +
        (untried > 0
          ? ` | ${untried} further candidate(s) left untried: no way to restore the pre-step state.`
          : ''),
    },
    null,
    currentPage,
  );
}

function describeCandidate(candidate: HealCandidate): string {
  return `[${candidate.ref}] ${candidate.confidence.toFixed(2)}`;
}
