import { generateBaseline } from '../baseline/generate.js';
import { describeLocator } from '../browser/locator.js';
import { loadBaseline, saveBaseline } from '../store/baselines.js';
import { loadPlan } from '../store/plans.js';
import { parseArgs } from '../util/args.js';

// ---------------------------------------------------------------------------
//   npm run baseline
//   npm run baseline -- --plan checkout-flow
//   npm run baseline -- --headed          # watch it drive the browser
//   npm run baseline -- --force           # regenerate even if a baseline exists
// ---------------------------------------------------------------------------
const PLAN_ID = 'checkout-flow';

async function main() {
  const { positionals, flags, options } = parseArgs();
  const planId = options.get('plan') ?? positionals[0] ?? PLAN_ID;
  const headed = flags.has('headed');
  const force = flags.has('force');

  const stored = await loadPlan(planId);
  if (!stored) throw new Error(`No plan "${planId}". Run: npm run plan`);

  const existing = await loadBaseline(planId);
  if (existing && !force) {
    console.log(`Baseline for "${planId}" already exists (${existing.createdAt}).`);
    console.log('Nothing to do — stage 3 will replay it. Pass --force to regenerate.');
    return;
  }

  console.log(`Plan        ${planId} — ${stored.plan.name}`);
  console.log(`Start URL   ${stored.plan.startUrl}`);
  console.log(`Steps       ${stored.plan.steps.length}\n`);

  const baseline = await generateBaseline({
    planId,
    plan: stored.plan,
    headed,
    onEvent: (event) => {
      switch (event.type) {
        case 'page':
          console.log(
            `\n· ${event.url} — ${event.elementCount} elements${event.truncated ? ' (truncated)' : ''}`,
          );
          break;
        case 'resolved':
          console.log(
            `  ${event.stepId}  ->  ${event.ref ?? 'NO MATCH'}  (${event.confidence.toFixed(2)})  ${event.reason}`,
          );
          break;
        case 'locator':
          console.log(
            `           locator: ${event.locator}${event.fallbacks > 0 ? `  (+${event.fallbacks} fallback)` : ''}`,
          );
          break;
        case 'executed':
          console.log(`           outcome: ${event.outcome}`);
          break;
        case 'warning':
          console.log(`           warning: ${event.message}`);
          break;
      }
    },
  });

  const filePath = await saveBaseline(baseline);

  console.log('\nBaseline recorded:\n');
  for (const step of baseline.steps) {
    const outcome = step.expectedOutcome;
    const assertion =
      outcome.type === 'elementVisible' && outcome.locator
        ? `elementVisible ${describeLocator(outcome.locator)}`
        : outcome.value
          ? `${outcome.type} "${outcome.value}"`
          : outcome.type;
    const target = step.locator ? describeLocator(step.locator) : '(no element — acts on the page)';
    console.log(`  ${step.stepId}  ${step.action.padEnd(8)} ${target}`);
    console.log(`            assert: ${assertion}`);
  }

  const unverifiable = baseline.steps.filter((s) => s.expectedOutcome.type === 'none');
  if (unverifiable.length > 0) {
    console.log(
      `\n${unverifiable.length} step(s) have no post-condition: ${unverifiable.map((s) => s.stepId).join(', ')}`,
    );
  }

  console.log(`\nSaved -> ${filePath}`);
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
