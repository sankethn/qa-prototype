import { generateIntentPlan } from '../intent/generate.js';
import { savePlan } from '../store/plans.js';

// ---------------------------------------------------------------------------
// Hardcoded inputs for the prototype. Edit these, or override from the CLI:
//   npm run plan -- "<test case in plain English>" [targetUrl] [planId]
//
// PLAN_ID is the stable identity of this test. Later stages look the baseline up
// by it, so it is ours to choose — deriving it from the model-authored plan name
// would fork the record every time the model reworded the name.
// ---------------------------------------------------------------------------
const PLAN_ID = 'checkout-flow';
const TARGET_URL = 'http://localhost:3000';
const INSTRUCTION =
  'Log in with my test account, view the product on the home page, and proceed to checkout.';
// ---------------------------------------------------------------------------

async function main() {
  const [instructionArg, urlArg, planIdArg] = process.argv.slice(2);
  const instruction = instructionArg ?? INSTRUCTION;
  const targetUrl = urlArg ?? TARGET_URL;
  const planId = planIdArg ?? PLAN_ID;

  console.log(`Target      ${targetUrl}`);
  console.log(`Test case   ${instruction}\n`);

  const { plan, model, attempts, warnings } = await generateIntentPlan({
    targetUrl,
    instruction,
    onAttempt: ({ attempt, errors }) => {
      if (errors.length === 0) return;
      console.log(`Attempt ${attempt} rejected:`);
      for (const error of errors) console.log(`  - ${error}`);
      console.log('Retrying with the validator feedback...\n');
    },
  });

  const { filePath, stored } = await savePlan({ plan, model, targetUrl, instruction, planId });

  console.log(JSON.stringify(stored.plan, null, 2));
  console.log();

  for (const warning of warnings) console.log(`Warning: ${warning}`);
  if (warnings.length > 0) console.log();

  console.log(`${plan.steps.length} steps, ${model}, ${attempts} attempt(s)`);
  if (plan.requiredValueRefs.length > 0) {
    console.log(`Requires in .env: ${plan.requiredValueRefs.join(', ')}`);
  }
  console.log(`Saved ${planId} -> ${filePath}`);
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
