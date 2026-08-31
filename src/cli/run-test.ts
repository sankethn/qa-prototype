import { describeLocator } from '../browser/locator.js';
import { attemptHeal, HEAL_THRESHOLD, type HealUpdate } from '../heal/engine.js';
import type { HealAttempt } from '../heal/types.js';
import { replayBaseline } from '../run/replay.js';
import { loadBaseline, saveBaseline } from '../store/baselines.js';
import { loadPlan } from '../store/plans.js';
import { saveRun } from '../store/runs.js';
import { parseArgs } from '../util/args.js';

// ---------------------------------------------------------------------------
//   npm run run:test
//   npm run run:test -- --plan checkout-flow --headed
//   npm run run:test -- --heal                  # attempt healing on stale locators
//   npm run run:test -- --heal --threshold 0.9
// ---------------------------------------------------------------------------
const PLAN_ID = 'checkout-flow';

async function main() {
  const { positionals, flags, options } = parseArgs();
  const planId = options.get('plan') ?? positionals[0] ?? PLAN_ID;
  const healing = flags.has('heal');
  const threshold = Number(options.get('threshold') ?? HEAL_THRESHOLD);

  const baseline = await loadBaseline(planId);
  if (!baseline) {
    const plan = await loadPlan(planId);
    throw new Error(
      plan
        ? `No baseline for "${planId}". Run: npm run baseline`
        : `No plan "${planId}". Run: npm run plan`,
    );
  }

  console.log(`Replaying   ${planId}  (baseline ${baseline.createdAt})`);
  console.log(`Start URL   ${baseline.startUrl}`);
  console.log(`Steps       ${baseline.steps.length}\n`);

  if (healing) console.log(`Healing     enabled, confidence gate ${threshold}\n`);

  const attempts: HealAttempt[] = [];
  const healed = new Map<string, HealUpdate>();

  const run = await replayBaseline({
    baseline,
    headed: flags.has('headed'),
    onHealableFailure: healing
      ? async ({ page, step, failure, restore }) => {
          const { attempt, update, page: currentPage } = await attemptHeal({
            page,
            step,
            failureMessage: failure.message,
            threshold,
            restore,
          });
          attempts.push(attempt);

          console.log(`         heal: ${attempt.status.toUpperCase()} (${attempt.confidence.toFixed(2)})`);
          console.log(`               ${attempt.reason}`);
          console.log(`               ${attempt.verification}`);

          // A rejected heal halts the run, and `restore` already swapped the
          // runner's page if it rebuilt state, so there is nothing to hand back.
          if (!update) return null;
          healed.set(step.stepId, update);
          return {
            healed: true,
            locator: update.locator,
            fallbacks: update.fallbacks,
            fingerprint: update.fingerprint,
            page: currentPage,
          };
        }
      : undefined,
    onEvent: (event) => {
      if (event.type === 'skipped') {
        console.log(`  ---  ${event.stepId}  skipped`);
        return;
      }
      if (event.type === 'healing') {
        console.log(`  ..   ${event.stepId}  stale locator, attempting heal`);
        return;
      }
      if (event.type === 'healError') {
        console.log(`         heal could not run: ${event.message}`);
        console.log('         the step keeps its original classification');
        return;
      }

      const { result } = event;
      const mark = result.status === 'passed' ? 'PASS' : 'FAIL';
      const via = result.usedFallback ? '  [via fallback]' : '';
      console.log(
        `  ${mark} ${result.stepId}  ${result.action.padEnd(8)} ${result.locatorUsed ? describeLocator(result.locatorUsed) : '-'}${via}`,
      );
      if (result.outcomeChecked) console.log(`         checked: ${result.outcomeChecked}`);

      if (result.failure) {
        console.log(`         ${result.failure.kind}`);
        console.log(`         ${result.failure.message}`);
        console.log(
          `         ${result.failure.healable ? `HEALABLE — ${healing ? 'the heal did not succeed.' : 'rerun with --heal to attempt a repair.'}` : 'NOT healable — treated as a real application failure.'}`,
        );
      }
    },
  });

  const filePath = await saveRun(run);

  // Only accepted heals reach here — each one already executed against the live
  // page and satisfied the step's original recorded outcome.
  if (healed.size > 0) {
    for (const step of baseline.steps) {
      const update = healed.get(step.stepId);
      if (!update) continue;
      step.healHistory.push(update.record);
      step.locator = update.locator;
      step.fallbackLocators = update.fallbacks;
      step.fingerprint = update.fingerprint;
    }
    await saveBaseline(baseline);
    console.log(`\n${healed.size} locator(s) updated in the baseline:`);
    for (const [stepId, update] of healed) {
      console.log(`  ${stepId}  ${describeLocator(update.record.previousLocator)}`);
      console.log(`         ->  ${describeLocator(update.locator)}`);
    }
  }

  const unhealed = attempts.filter((a) => a.status !== 'accepted');
  if (unhealed.length > 0) {
    console.log(`\n${unhealed.length} heal attempt(s) did not succeed:`);
    for (const attempt of unhealed) {
      console.log(`  ${attempt.stepId}  ${attempt.status}  (${attempt.confidence.toFixed(2)})  ${attempt.reason}`);
    }
  }

  const passed = run.steps.filter((s) => s.status === 'passed').length;
  const drifted = run.steps.filter((s) => s.usedFallback);

  if (run.failure) {
    console.log(`\n  ${run.failure.kind}`);
    console.log(`  ${run.failure.message}`);
    console.log('  NOT healable — the run never started, so the test was never exercised.');
  }

  console.log(`\n${run.status.toUpperCase()} — ${passed}/${run.steps.length} steps passed`);

  if (drifted.length > 0) {
    console.log(
      `${drifted.length} step(s) passed only via a fallback locator: ${drifted.map((s) => s.stepId).join(', ')}`,
    );
    console.log('The baseline has drifted; the primary locator no longer matches.');
  }

  const unverified = run.steps.filter(
    (s) => s.status === 'passed' && s.outcomeChecked.startsWith('none'),
  );
  if (unverified.length > 0) {
    console.log(
      `${unverified.length} step(s) passed without a post-condition: ${unverified.map((s) => s.stepId).join(', ')}`,
    );
  }

  console.log(`Saved -> ${filePath}`);
  process.exitCode = run.status === 'failed' ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
