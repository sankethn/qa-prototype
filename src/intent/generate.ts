import { generateJson } from '../llm/openai.js';
import { buildPrompt, buildRepairPrompt, SYSTEM_INSTRUCTION } from './prompt.js';
import { collectValueRefs, collectWarnings, validatePlanRules } from './validate.js';
import { generatedPlanSchema, type GeneratedPlan, type IntentPlan } from './types.js';

export interface GenerateIntentPlanOptions {
  targetUrl: string;
  instruction: string;
  /** Repair attempts after the first try. 0 disables the repair loop. */
  maxRepairs?: number;
  onAttempt?: (info: { attempt: number; errors: string[] }) => void;
}

export interface GenerateIntentPlanResult {
  plan: IntentPlan;
  model: string;
  attempts: number;
  warnings: string[];
}

/**
 * Natural language -> intent plan.
 *
 * Three layers of constraint, narrowest last:
 *   1. responseSchema  - the model cannot emit the wrong shape or an unknown action.
 *   2. zod parse       - we do not trust the wire, we re-check it.
 *   3. rule validation - cross-field contracts, with errors fed back for repair.
 */
export async function generateIntentPlan({
  targetUrl,
  instruction,
  maxRepairs = 2,
  onAttempt,
}: GenerateIntentPlanOptions): Promise<GenerateIntentPlanResult> {
  let prompt = buildPrompt(targetUrl, instruction);
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const { data, raw, model } = await generateJson({
      prompt,
      schema: generatedPlanSchema,
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    const parsed = generatedPlanSchema.safeParse(data);
    const errors: string[] = parsed.success
      ? validatePlanRules(parsed.data, instruction)
      : parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);

    onAttempt?.({ attempt, errors });

    if (parsed.success && errors.length === 0) {
      return {
        plan: finalizePlan(parsed.data, targetUrl),
        model,
        attempts: attempt,
        warnings: collectWarnings(parsed.data),
      };
    }

    lastErrors = errors;
    prompt = buildRepairPrompt(targetUrl, instruction, raw, errors);
  }

  throw new Error(
    `Could not produce a valid intent plan after ${maxRepairs + 1} attempts:\n` +
      lastErrors.map((e) => `  - ${e}`).join('\n'),
  );
}

/** Attach the fields we own rather than let the model invent them. */
function finalizePlan(generated: GeneratedPlan, targetUrl: string): IntentPlan {
  return {
    ...generated,
    startUrl: targetUrl,
    requiredValueRefs: collectValueRefs(generated.steps),
  };
}
