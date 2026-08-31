import { z } from 'zod';

/**
 * The closed action vocabulary. The model may only ever emit one of these, so a
 * hallucinated action is impossible rather than merely unlikely. Every later
 * stage (baseline, execution, healing) switches on exactly this set.
 */
export const ACTIONS = [
  'navigate',
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'hover',
  'assert',
  'waitFor',
] as const;

export type Action = (typeof ACTIONS)[number];

/** Actions that operate on a page rather than an element. */
export function actsOnElement(action: Action): boolean {
  return action !== 'navigate';
}

type Requirement = 'required' | 'optional' | 'forbidden';

/**
 * Per-action structural rules, enforced after schema validation. JSON Schema
 * cannot express "fill needs a value but click must not have one", so this
 * table carries that contract instead.
 *
 * `value` covers value-or-valueRef: exactly one of the two.
 * `outcome` is required for actions that move the application forward — a step
 * with no post-condition gives the healer nothing to verify a candidate against.
 */
export const ACTION_RULES: Record<
  Action,
  { target: Requirement; value: Requirement; outcome: Requirement }
> = {
  navigate: { target: 'forbidden', value: 'required', outcome: 'required' }, // value = the URL
  click: { target: 'required', value: 'forbidden', outcome: 'required' },
  fill: { target: 'required', value: 'required', outcome: 'optional' },
  select: { target: 'required', value: 'required', outcome: 'optional' },
  check: { target: 'required', value: 'forbidden', outcome: 'optional' },
  uncheck: { target: 'required', value: 'forbidden', outcome: 'optional' },
  press: { target: 'optional', value: 'required', outcome: 'optional' }, // value = the key, e.g. "Enter"
  hover: { target: 'required', value: 'forbidden', outcome: 'optional' },
  assert: { target: 'required', value: 'forbidden', outcome: 'required' },
  waitFor: { target: 'required', value: 'forbidden', outcome: 'optional' },
};

/**
 * A semantic description of an element. Deliberately selector-free: this layer
 * must survive a redesign, so it may not mention CSS, XPath, or DOM structure.
 */
export const targetSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe(
      'What the element is, in human terms. E.g. "email input field", "add to cart button". ' +
        'Never a CSS selector, XPath, tag name, or class name.',
    ),
  context: z
    .string()
    .nullable()
    .describe(
      'Where on the page it sits, used to disambiguate repeats. E.g. "login form", ' +
        '"first product card", "order summary panel". Null if the page has only one such element.',
    ),
});

export const expectedOutcomeSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe(
      'The observable result in plain language, e.g. "user is signed in and sees the product list". ' +
        'Describe what a human would see; do not invent URLs, status codes, or element ids.',
    ),
});

export const stepSchema = z.object({
  id: z.string().min(1).describe('Stable step identifier, sequential: "step-1", "step-2", ...'),
  intent: z
    .string()
    .min(1)
    .describe('What this step is trying to accomplish, in one short sentence.'),
  sourcePhrase: z
    .string()
    .min(1)
    .describe(
      'The fragment of the tester\'s instruction that this step comes from, copied VERBATIM ' +
        'from the instruction text. It is checked as a literal substring, so do not paraphrase, ' +
        'reorder, or summarise. Several steps may quote the same fragment when one phrase ' +
        'decomposes into several interactions. If you cannot quote the instruction for a step, ' +
        'the step does not belong in the plan.',
    ),
  action: z.enum(ACTIONS).describe('The interaction to perform. Must be one of the allowed values.'),
  target: targetSchema
    .nullable()
    .describe('The element being acted on. Null only for "navigate".'),
  value: z
    .string()
    .nullable()
    .describe(
      'A literal value to use. For "navigate" this is the URL; for "press" the key name. ' +
        'Null when the step takes no value or when the value is a secret (use valueRef instead).',
    ),
  valueRef: z
    .string()
    .nullable()
    .describe(
      'Name of an environment variable holding the value, SCREAMING_SNAKE_CASE. ' +
        'Always use this instead of "value" for credentials, emails, and any test data ' +
        'the user did not spell out literally. E.g. TEST_EMAIL, TEST_PASSWORD.',
    ),
  expectedOutcome: expectedOutcomeSchema
    .nullable()
    .describe(
      'What should be observably true after this step. Required for "assert". ' +
        'Otherwise set it only when the step is expected to change the page state, ' +
        'and null for steps that just enter data.',
    ),
});

/** What the model is asked to produce. `startUrl` is injected by us, not generated. */
export const generatedPlanSchema = z.object({
  name: z.string().min(1).describe('Short human name for this test, e.g. "Checkout Flow".'),
  description: z
    .string()
    .min(1)
    .describe('One sentence describing what the test covers end to end.'),
  steps: z
    .array(stepSchema)
    .min(1)
    .describe('The ordered steps. Each must be a single atomic interaction.'),
});

/** The stored plan: the model's output plus the fields we own. */
export const intentPlanSchema = generatedPlanSchema.extend({
  startUrl: z.url(),
  requiredValueRefs: z.array(z.string()),
});

export type Target = z.infer<typeof targetSchema>;
export type ExpectedOutcome = z.infer<typeof expectedOutcomeSchema>;
export type IntentStep = z.infer<typeof stepSchema>;
export type GeneratedPlan = z.infer<typeof generatedPlanSchema>;
export type IntentPlan = z.infer<typeof intentPlanSchema>;

/** Provenance envelope written to disk, so a stale plan is always explicable. */
export const storedPlanSchema = z.object({
  planId: z.string(),
  createdAt: z.string(),
  model: z.string(),
  source: z.object({
    targetUrl: z.string(),
    instruction: z.string(),
  }),
  plan: intentPlanSchema,
});

export type StoredPlan = z.infer<typeof storedPlanSchema>;
