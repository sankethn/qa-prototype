import { ACTION_RULES, type GeneratedPlan, type IntentStep } from './types.js';

/**
 * Structural rules JSON Schema cannot express. Runs after the zod parse, and its
 * messages are fed back to the model verbatim on a repair attempt — so each one
 * has to say what is wrong and what to do instead.
 *
 * `instruction` is the tester's original text, used to ground every step against
 * it. That check is what stops the model padding a plan out of its own priors.
 */
export function validatePlanRules(plan: GeneratedPlan, instruction: string): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const normalizedInstruction = normalize(instruction);

  plan.steps.forEach((step, index) => {
    const where = `${step.id || `step at index ${index}`} (${step.action})`;

    if (seenIds.has(step.id)) errors.push(`${where}: duplicate step id "${step.id}".`);
    seenIds.add(step.id);

    const expectedId = `step-${index + 1}`;
    if (step.id !== expectedId) {
      errors.push(`${where}: step ids must be sequential; expected id "${expectedId}".`);
    }

    const rules = ACTION_RULES[step.action];
    const hasValue = step.value !== null || step.valueRef !== null;

    if (rules.target === 'required' && step.target === null) {
      errors.push(`${where}: this action requires a target describing the element.`);
    }
    if (rules.target === 'forbidden' && step.target !== null) {
      errors.push(`${where}: this action must have target set to null.`);
    }

    if (rules.value === 'required' && !hasValue) {
      errors.push(`${where}: this action requires either value or valueRef.`);
    }
    if (rules.value === 'forbidden' && hasValue) {
      errors.push(`${where}: this action must have both value and valueRef set to null.`);
    }
    if (step.value !== null && step.valueRef !== null) {
      errors.push(`${where}: set value or valueRef, never both.`);
    }

    if (step.valueRef !== null && !/^[A-Z][A-Z0-9_]*$/.test(step.valueRef)) {
      errors.push(`${where}: valueRef "${step.valueRef}" must be SCREAMING_SNAKE_CASE.`);
    }

    if (rules.outcome === 'required' && step.expectedOutcome === null) {
      errors.push(
        `${where}: this action moves the application forward, so it must have an ` +
          'expectedOutcome describing what a human would then observe.',
      );
    }

    if (step.expectedValue !== null) {
      if (step.action !== 'assert') {
        errors.push(`${where}: expectedValue is only meaningful on an assert step.`);
      }
      // Grounded like sourcePhrase: an inferred value would pin the test to
      // something the tester never asked for, failing on every data change.
      if (!normalizedInstruction.includes(normalize(step.expectedValue))) {
        errors.push(
          `${where}: expectedValue "${step.expectedValue}" does not appear in the tester's ` +
            'instruction. Use null unless they stated the value themselves.',
        );
      }
    }

    // The grounding check: every step must quote the instruction it came from.
    // A step that cannot is one the model invented.
    if (!normalizedInstruction.includes(normalize(step.sourcePhrase))) {
      errors.push(
        `${where}: sourcePhrase "${step.sourcePhrase}" does not appear in the tester's ` +
          'instruction. Quote the instruction verbatim, or drop the step entirely if the ' +
          'tester never asked for it.',
      );
    }

    if (step.target?.description && looksLikeSelector(step.target.description)) {
      errors.push(
        `${where}: target.description "${step.target.description}" looks like a selector. ` +
          'Describe the element in human terms instead.',
      );
    }
  });

  return errors;
}

/**
 * Loose enough to survive the model re-casing or re-punctuating a quote, strict
 * enough that it still has to be the tester's actual words in the actual order.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

const SELECTOR_HINTS = [
  /^[.#]\S/, //  .class  #id
  /\[[^\]]+=/, //  [data-test="x"]
  /^\/\//, //  //div[@id]
  /\b(?:div|span|input|button|form|a|ul|li|table|td)\s*[.#[>]/i,
  /\bnth-child\b|\bcss=|\bxpath=/i,
];

function looksLikeSelector(description: string): boolean {
  return SELECTOR_HINTS.some((pattern) => pattern.test(description.trim()));
}

/** Non-blocking smells worth surfacing to the operator. */
export function collectWarnings(plan: GeneratedPlan): string[] {
  const warnings: string[] = [];
  const SENSITIVE = /pass(word|code)|secret|token|card number|cvv|otp/i;

  for (const step of plan.steps) {
    if (step.value !== null && SENSITIVE.test(`${step.intent} ${step.target?.description ?? ''}`)) {
      warnings.push(
        `${step.id}: appears to be sensitive data but uses a literal value. Prefer a valueRef.`,
      );
    }
  }
  return warnings;
}

/** Derived in code rather than asked of the model — one less thing to hallucinate. */
export function collectValueRefs(steps: IntentStep[]): string[] {
  return [...new Set(steps.flatMap((s) => (s.valueRef ? [s.valueRef] : [])))].sort();
}
