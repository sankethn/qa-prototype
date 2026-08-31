import { describeLocator } from '../browser/locator.js';
import { attemptHeal } from '../heal/engine.js';
import type { HealAttempt } from '../heal/types.js';
import { replayBaseline } from '../run/replay.js';
import { loadBaseline } from '../store/baselines.js';
import type { Baseline } from '../baseline/types.js';
import type { RunResult } from '../run/types.js';
import { parseArgs } from '../util/args.js';

// ---------------------------------------------------------------------------
// Integration test for the failure classifier.
//
// A passing run never exercises the heal/don't-heal decision, so this injects
// known faults into an in-memory copy of a baseline and asserts the verdict.
// The stored baseline and the application are never modified.
//
//   npm run drill
//   npm run drill -- --plan checkout-flow
// ---------------------------------------------------------------------------

interface Drill {
  name: string;
  expect: string;
  mutate: (baseline: Baseline) => Baseline;
  /** Returns null when the run matched expectations, or the mismatch to report. */
  check: (run: RunResult, attempts: HealAttempt[]) => string | null;
  /** Heal drills call the model, so they only run with --heal. */
  heals?: boolean;
}

const clone = (baseline: Baseline): Baseline => structuredClone(baseline);

/** Asserts a specific step failed with a given kind and healability. */
function expectStepFailure(kind: string, healable: boolean) {
  return (run: RunResult): string | null => {
    if (run.failure) return `run-level ${run.failure.kind}, expected a step failure`;
    const failed = run.steps.find((s) => s.status === 'failed');
    if (!failed?.failure) return 'no step failed';
    if (failed.failure.kind !== kind) return `got ${failed.failure.kind}`;
    if (failed.failure.healable !== healable) {
      return `healable=${failed.failure.healable}, expected ${healable}`;
    }
    return null;
  };
}

const DRILLS: Drill[] = [
  {
    name: 'Primary locator renamed, fallback intact',
    expect: 'passes via fallback, reported as drift',
    mutate: (base) => {
      const b = clone(base);
      b.steps[2]!.locator!.name = 'Log in';
      return b;
    },
    check: (run) => {
      if (run.status !== 'passed') return `run ${run.status}, expected passed`;
      return run.steps.some((s) => s.usedFallback) ? null : 'no fallback usage was reported';
    },
  },
  {
    name: 'Element genuinely gone (primary and fallback both stale)',
    expect: 'ELEMENT_NOT_FOUND, healable',
    mutate: (base) => {
      const b = clone(base);
      b.steps[2]!.locator!.name = 'Log in';
      b.steps[2]!.fallbackLocators = [];
      return b;
    },
    check: expectStepFailure('ELEMENT_NOT_FOUND', true),
  },
  {
    name: 'Business regression: element fine, outcome wrong',
    expect: 'OUTCOME_NOT_MET, NOT healable',
    mutate: (base) => {
      const b = clone(base);
      // Break the URL assertion only — the element and the click are untouched,
      // which is what makes this a business regression rather than a stale test.
      const urlAssertion = b.steps[2]!.expectedOutcome.assertions.find(
        (a) => a.type === 'urlContains',
      );
      if (!urlAssertion) throw new Error('step-3 has no urlContains assertion to break');
      urlAssertion.value = '/dashboard';
      return b;
    },
    check: expectStepFailure('OUTCOME_NOT_MET', false),
  },
  {
    name: 'Application unreachable',
    expect: 'run-level NETWORK_ERROR, NOT healable',
    mutate: (base) => {
      const b = clone(base);
      b.startUrl = 'http://localhost:59999/';
      return b;
    },
    check: (run) => {
      if (!run.failure) return 'expected a run-level failure';
      if (run.failure.kind !== 'NETWORK_ERROR') return `got ${run.failure.kind}`;
      return run.failure.healable ? 'marked healable; an unreachable app must never be' : null;
    },
  },

  {
    // Before app health was checked ahead of locator reasoning, this presented as
    // ELEMENT_NOT_FOUND and would have invited a heal against an error page.
    name: 'Page returns 4xx — elements are missing because the route is gone',
    expect: 'HTTP_ERROR, NOT healable',
    mutate: (base) => {
      const b = clone(base);
      b.startUrl = 'http://localhost:3000/no-such-route';
      return b;
    },
    check: expectStepFailure('HTTP_ERROR', false),
  },

  {
    // Stands in for the general case: an expired session bouncing us to /login,
    // an unexpected redirect, or an earlier step ending somewhere unintended.
    // Every element goes missing, which without this check reads as a rename.
    name: 'Browser is not on the page the step was recorded against',
    expect: 'PAGE_DIVERGED, NOT healable',
    mutate: (base) => {
      const b = clone(base);
      b.steps[1]!.pageUrl = 'http://localhost:3000/some-other-page';
      return b;
    },
    check: expectStepFailure('PAGE_DIVERGED', false),
  },

  // --- Healing drills. These call the model, so they need --heal. ------------
  {
    name: 'HEAL: stale locator, the real control is still on the page',
    expect: 'heal accepted, run completes, locator points back at the real button',
    heals: true,
    mutate: (base) => {
      const b = clone(base);
      b.steps[2]!.locator!.name = 'Log in';
      b.steps[2]!.fallbackLocators = [];
      return b;
    },
    check: (run, attempts) => {
      const attempt = attempts[0];
      if (!attempt) return 'the healer was never invoked';
      if (attempt.status !== 'accepted') return `heal ${attempt.status}: ${attempt.verification}`;
      if (run.status !== 'passed') return 'heal accepted but the run did not complete';
      if (attempt.newLocator?.name !== 'Sign in') {
        return `healed to "${attempt.newLocator?.name}", expected the real "Sign in" button`;
      }
      return null;
    },
  },
  {
    // step-4's real target is the product heading. Pointed at a generic "product
    // area" instead, the model has several plausible elements to choose from, so
    // if its first pick fails verification the run must restore and try the next.
    name: 'HEAL: ambiguous target, may need a second candidate',
    expect: 'heal accepted; more than one candidate may be executed',
    heals: true,
    mutate: (base) => {
      const b = clone(base);
      const step = b.steps[3]!;
      step.locator = { strategy: 'role', value: null, role: 'heading', name: 'Product', nth: null };
      step.fallbackLocators = [];
      step.fingerprint!.accessibleName = 'Product';
      step.fingerprint!.text = 'Product';
      return b;
    },
    check: (run, attempts) => {
      const attempt = attempts[0];
      if (!attempt) return 'the healer was never invoked';
      if (attempt.status === 'accepted' && run.status !== 'passed') {
        return 'heal accepted but the run did not complete';
      }
      // Either verdict is legitimate here; what must hold is that a rejected
      // first candidate did not silently end the attempt when others remained.
      if (attempt.status === 'rejected' && attempt.candidatesProposed > 1 && attempt.candidatesTried < 2) {
        return `${attempt.candidatesProposed} candidates proposed but only ${attempt.candidatesTried} tried`;
      }
      return null;
    },
  },
  {
    name: 'HEAL: the control genuinely does not exist',
    expect: 'no candidate proposed, step fails safely',
    heals: true,
    mutate: (base) => {
      const b = clone(base);
      const step = b.steps[4]!;
      step.intent = 'Apply a discount coupon to the order';
      step.locator = { strategy: 'role', value: null, role: 'button', name: 'Apply coupon', nth: null };
      step.fallbackLocators = [];
      step.fingerprint!.role = 'button';
      step.fingerprint!.accessibleName = 'Apply coupon';
      step.fingerprint!.text = 'Apply coupon';
      return b;
    },
    check: (run, attempts) => {
      const attempt = attempts[0];
      if (!attempt) return 'the healer was never invoked';
      if (attempt.status === 'accepted') {
        return `healed a control that does not exist, to "${attempt.newLocator?.name}" — this is the dangerous case`;
      }
      if (run.status !== 'failed') return 'run should have failed';
      return null;
    },
  },
];

async function main() {
  const { options, flags } = parseArgs();
  const planId = options.get('plan') ?? 'checkout-flow';
  const withHealing = flags.has('heal');

  const baseline = await loadBaseline(planId);
  if (!baseline) throw new Error(`No baseline for "${planId}". Run: npm run baseline`);

  const selected = DRILLS.filter((d) => !d.heals || withHealing);
  if (!withHealing) console.log('(heal drills skipped — pass --heal to include them)');

  let failures = 0;

  for (const drill of selected) {
    console.log(`\n${drill.name}`);
    console.log(`  expect:  ${drill.expect}`);

    const attempts: HealAttempt[] = [];
    let run: RunResult;
    try {
      run = await replayBaseline({
        baseline: drill.mutate(baseline),
        // Healing is only wired in for heal drills, so the classifier drills stay
        // model-free and keep verifying the un-healed behaviour.
        onHealableFailure: drill.heals
          ? async ({ page, step, failure, restore }) => {
              const { attempt, update, page: currentPage } = await attemptHeal({
                page,
                step,
                failureMessage: failure.message,
                restore,
              });
              attempts.push(attempt);
              return update
                ? {
                    healed: true,
                    locator: update.locator,
                    fallbacks: update.fallbacks,
                    fingerprint: update.fingerprint,
                    page: currentPage,
                  }
                : null;
            }
          : undefined,
      });
    } catch (err) {
      failures++;
      console.log(`  FAIL     escaped the classifier as a raw throw — ${messageOf(err)}`);
      continue;
    }

    const mismatch = drill.check(run, attempts);
    if (mismatch) {
      failures++;
      console.log(`  FAIL     ${mismatch}`);
      console.log(`           actual: ${describe(run)}`);
      const detail = run.failure ?? run.steps.find((s) => s.status === 'failed')?.failure;
      if (detail) console.log(`           ${detail.message}`);
    } else {
      console.log(`  ok       ${describe(run)}`);
    }

    for (const attempt of attempts) {
      const to = attempt.newLocator ? ` -> ${describeLocator(attempt.newLocator)}` : '';
      console.log(
        `           heal ${attempt.status} (${attempt.confidence.toFixed(2)} vs gate ${attempt.threshold})${to}`,
      );
      console.log(
        `           candidates: ${attempt.candidatesProposed} proposed, ${attempt.candidatesTried} executed`,
      );
      console.log(`           model: ${attempt.reason}`);
      console.log(`           check: ${attempt.verification}`);
    }
  }

  console.log(
    `\n${failures === 0 ? "All" : `${selected.length - failures}/${selected.length}`} drills passed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

function describe(run: RunResult): string {
  if (run.failure) {
    return `run-level ${run.failure.kind} — ${run.failure.healable ? 'HEALABLE' : 'not healable'}`;
  }
  const failed = run.steps.find((s) => s.status === 'failed');
  if (failed?.failure) {
    return `${failed.stepId} ${failed.failure.kind} — ${failed.failure.healable ? 'HEALABLE' : 'not healable'}`;
  }
  const drifted = run.steps.filter((s) => s.usedFallback).map((s) => s.stepId);
  return `passed${drifted.length > 0 ? ` — via fallback at ${drifted.join(', ')}` : ''}`;
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split('\n')[0] ?? raw;
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
