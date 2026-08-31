import { z } from 'zod';
import { generateJson } from '../llm/gemini.js';
import { renderElementsForPrompt, type PageSnapshot } from '../browser/extract.js';
import type { IntentStep } from '../intent/types.js';

const resolutionSchema = z.object({
  ref: z
    .string()
    .nullable()
    .describe(
      'The ref of the single best matching element, exactly as shown in brackets ' +
        '(e.g. "s0e4"). Null if no element on this page satisfies the step.',
    ),
  confidence: z
    .number()
    .describe(
      'How certain you are, from 0 to 1. Above 0.9 means the match is unmistakable. ' +
        'Below 0.5 means you are guessing. Report your real certainty; a low score is ' +
        'more useful than a confident wrong answer.',
    ),
  reason: z
    .string()
    .describe('One sentence on why this element matches the intent, or why nothing does.'),
});

export type StepResolution = z.infer<typeof resolutionSchema>;

const SYSTEM_INSTRUCTION = `You match one step of a QA test to one element on a web page.

You are given the step's intent and a semantic description of its target, plus every
candidate element currently on the page. Choose the single element a human tester would
click, fill or check for this step.

RULES

1. Choose from the given elements only. Return the ref verbatim. Never invent a ref.

2. If no element on this page satisfies the step, return ref: null with a low confidence
   and say what is missing. That is a correct and useful answer — the page may simply be
   the wrong one, and a wrong guess is far more damaging than an honest miss.

3. Match on meaning, not on wording. "sign in action" matches a button named "Log in".
   Role matters: a "fill" step needs a textbox, a "click" step needs something clickable.

4. Use the target's context and the elements' "in=" and "near=" fields to disambiguate
   repeated elements. If several elements match equally well and nothing distinguishes
   them, lower your confidence and say so.

5. Prefer the element that does the step's job directly. For "proceed to checkout",
   a button named "Checkout" beats a nav link named "Cart" that would eventually get there.

6. Elements marked DISABLED cannot be acted on. Elements marked "static" are not
   clickable and are only valid targets for assert or waitFor steps.`;

export interface ResolveStepParams {
  step: IntentStep;
  snapshot: PageSnapshot;
  /** Steps already executed, so the model knows where in the flow it is. */
  history: string[];
}

export async function resolveStep({
  step,
  snapshot,
  history,
}: ResolveStepParams): Promise<{ resolution: StepResolution; model: string }> {
  const target = step.target;
  const prompt = [
    history.length > 0 ? `Steps already completed:\n${history.map((h) => `  - ${h}`).join('\n')}\n` : '',
    'Step to resolve:',
    `  intent: ${step.intent}`,
    `  action: ${step.action}`,
    `  target: ${target?.description ?? '(none)'}`,
    `  target context: ${target?.context ?? '(none given)'}`,
    '',
    'Candidate elements on the current page:',
    renderElementsForPrompt(snapshot),
    '',
    'Return the single best matching element.',
  ]
    .filter(Boolean)
    .join('\n');

  const { data, model } = await generateJson({
    prompt,
    schema: resolutionSchema,
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0,
  });

  return { resolution: resolutionSchema.parse(data), model };
}
