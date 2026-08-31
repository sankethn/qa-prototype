import { z } from 'zod';
import { ACTIONS } from '../intent/types.js';

/**
 * How to find an element at execution time. Kept flat rather than a discriminated
 * union because the healing stage has to emit these through Gemini's schema
 * dialect, which has no real union support — one shape with nullable fields
 * survives that round trip intact.
 */
export const LOCATOR_STRATEGIES = [
  'testId',
  'role',
  'label',
  /**
   * The element sitting immediately after a label, identified by the label's
   * text rather than its own.
   *
   * This is how a *value* gets a stable identity. A displayed total, status or
   * name has no test id and no accessible name, so the only thing left is its
   * own content — and anchoring on content means a data change breaks the
   * locator, arrives as ELEMENT_NOT_FOUND, and gets healed into the new value.
   * A pricing regression would be indistinguishable from a rename.
   *
   * One relationship covers the common markup for label/value pairs:
   * `<dt>`/`<dd>`, `<label>` and its field, `<th>`/`<td>` in a row, and two
   * sibling spans. All four are "the next sibling of the labelling element".
   */
  'labelledBy',
  'placeholder',
  'altText',
  'text',
  'css',
] as const;

export type LocatorStrategy = (typeof LOCATOR_STRATEGIES)[number];

export const locatorSchema = z.object({
  strategy: z.enum(LOCATOR_STRATEGIES),
  /**
   * testid / label text / placeholder / alt / visible text / css selector.
   * For `labelledBy` this is the label's exact text. Null for `role`.
   */
  value: z.string().nullable(),
  /** `role` strategy only. */
  role: z.string().nullable(),
  /** `role` strategy only: the accessible name. */
  name: z.string().nullable(),
  /**
   * Index when the locator legitimately matches several elements ("the first
   * product card"). Null means it must match exactly one.
   */
  nth: z.number().int().nonnegative().nullable(),
});

export type Locator = z.infer<typeof locatorSchema>;

/**
 * What the element looked like when the baseline was recorded. This is evidence
 * for the healer, never a matching condition — every field here is allowed to
 * drift without that alone meaning the test is broken.
 */
export const fingerprintSchema = z.object({
  role: z.string(),
  tagName: z.string(),
  accessibleName: z.string(),
  text: z.string(),
  ariaLabel: z.string().nullable(),
  id: z.string().nullable(),
  testId: z.string().nullable(),
  nameAttr: z.string().nullable(),
  inputType: z.string().nullable(),
  placeholder: z.string().nullable(),
  /** Nearest landmark, form, heading or labelled region containing the element. */
  context: z.string().nullable(),
  nearbyText: z.array(z.string()),
});

export type Fingerprint = z.infer<typeof fingerprintSchema>;

/**
 * The typed post-condition, derived from what Playwright actually observed after
 * the step ran — not from the model's guess in the intent plan. `none` is an
 * honest record that nothing verifiable changed, which is better than inventing
 * an assertion that would pass vacuously.
 */
export const ASSERTION_TYPES = [
  'urlContains',
  'elementVisible',
  /** The element's text is exactly this. Only recorded when the tester named a value. */
  'textEquals',
  'inputFilled',
] as const;

export const assertionSchema = z.object({
  type: z.enum(ASSERTION_TYPES),
  value: z.string().nullable(),
  locator: locatorSchema.nullable(),
});

export type Assertion = z.infer<typeof assertionSchema>;

/**
 * A step's post-condition, as a set of assertions that must all hold.
 *
 * A single assertion is too weak to mean much. `urlContains "/checkout"` is
 * equally true of the real page, a 500 error page served at that path, an SPA
 * that routed and then rendered an error boundary, and an empty shell. Requiring
 * the URL *and* something that only exists on the working page turns "we got
 * there" into "it actually rendered".
 *
 * It also separates identity from value. `elementVisible` says the total is on
 * screen; `textEquals` says what it reads. Keeping the value here rather than in
 * the locator is what makes a changed price fail as OUTCOME_NOT_MET — a real
 * failure, never healed — instead of ELEMENT_NOT_FOUND, which would be repaired
 * into the new price and hide the regression.
 *
 * An empty list is an honest record that nothing verifiable changed.
 */
export const expectedOutcomeSchema = z.object({
  assertions: z.array(assertionSchema),
  /** The intent plan's prose expectation, kept for the healer's context. */
  intended: z.string().nullable(),
});

export type BaselineOutcome = z.infer<typeof expectedOutcomeSchema>;

/**
 * One accepted heal. Lives on the baseline rather than in a separate log so the
 * record travels with the thing it changed — when a locator looks wrong, the
 * reason it became that locator is in the same file.
 */
export const healRecordSchema = z.object({
  healedAt: z.string(),
  confidence: z.number(),
  reason: z.string(),
  model: z.string(),
  previousLocator: locatorSchema,
  previousFingerprint: fingerprintSchema,
});

export type HealRecord = z.infer<typeof healRecordSchema>;

export const baselineStepSchema = z.object({
  stepId: z.string(),
  intent: z.string(),
  action: z.enum(ACTIONS),
  value: z.string().nullable(),
  valueRef: z.string().nullable(),
  /** URL the step was resolved and executed on. */
  pageUrl: z.string(),
  /**
   * Null for steps that act on no element — `navigate` goes to a URL and has no
   * target. Recording a locator for those would mean inventing one, and replay
   * would then look it up and report a missing element on a step that never had
   * one, which is a false healable failure.
   */
  locator: locatorSchema.nullable(),
  /** Ranked alternates, tried before healing is ever considered. */
  fallbackLocators: z.array(locatorSchema),
  fingerprint: fingerprintSchema.nullable(),
  expectedOutcome: expectedOutcomeSchema,
  /** Why the model picked this element. Provenance for debugging a bad baseline. */
  resolution: z.object({
    confidence: z.number(),
    reason: z.string(),
  }),
  /** Every accepted heal, oldest first. Defaulted so pre-healing baselines still load. */
  healHistory: z.array(healRecordSchema).default([]),
});

export type BaselineStep = z.infer<typeof baselineStepSchema>;

export const baselineSchema = z.object({
  baselineId: z.string(),
  planId: z.string(),
  createdAt: z.string(),
  model: z.string(),
  startUrl: z.string(),
  steps: z.array(baselineStepSchema),
});

export type Baseline = z.infer<typeof baselineSchema>;
