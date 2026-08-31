import { renderElementsForPrompt, type PageSnapshot } from '../browser/extract.js';
import { describeLocator } from '../browser/locator.js';
import { generateJson } from '../llm/gemini.js';
import type { BaselineStep } from '../baseline/types.js';
import { healProposalSchema, type HealProposal } from './types.js';

const SYSTEM_INSTRUCTION = `A recorded UI test step can no longer find its element. You propose a replacement.

You are given four things:
  1. The original intent — what the step was trying to accomplish.
  2. A fingerprint of the element as it was when the test was recorded.
  3. Every element currently on the page.
  4. The outcome the step is expected to produce.

Your job is to find the element that now serves the SAME PURPOSE as the original.

RULES

1. Same purpose, not same appearance. "Checkout" becoming "Continue to Payment" is the
   same action renamed. "Checkout" becoming "Save for later" is a different action that
   happens to sit in the same place — that is not a match.

2. The fingerprint is evidence, not a checklist. Every field in it is allowed to have
   changed; that is why you are being asked. Weigh role and purpose heavily, position
   and neighbouring text lightly, and exact wording least of all.

3. Role compatibility matters. A step that fills text needs a textbox. A step that clicks
   needs something clickable. A link and a button are interchangeable if they do the same
   job; a heading and a button are not.

4. Return an EMPTY list when nothing serves the original purpose. A removed feature, a
   page that no longer has this control, an entirely different screen — all correct empty
   answers. Never reach for the closest-looking element to avoid returning nothing.

5. Rank candidates best first, at most 3. Only add a second or third if it is genuinely
   plausible. Every candidate you list may actually be clicked against the running
   application, so a padded list is not free — it is a list of things that will be done.

6. Score confidence honestly. It gates whether a candidate is executed at all:
     0.90+  unmistakably the same control, renamed or restyled
     0.70   plausible but you are inferring from position or context
     0.40-  guessing
   A low score on a correct answer is far better than a high score on a wrong one.

7. Your proposal is not the final word. Candidates are executed and the original expected
   outcome is checked against reality. Propose what you believe is right and let the
   verification decide.`;

export interface ProposeHealParams {
  step: BaselineStep;
  snapshot: PageSnapshot;
  /** Why the step failed, so the model knows what it is compensating for. */
  failureMessage: string;
}

export async function proposeHeal({
  step,
  snapshot,
  failureMessage,
}: ProposeHealParams): Promise<{ proposal: HealProposal; model: string }> {
  const fingerprint = step.fingerprint;
  const staleLocator = step.locator;
  const outcome = step.expectedOutcome;

  if (!fingerprint || !staleLocator) {
    throw new Error(`Step ${step.stepId} has no element fingerprint to reason about.`);
  }

  const prompt = [
    'ORIGINAL INTENT',
    `  ${step.intent}`,
    `  action: ${step.action}`,
    '',
    'PREVIOUS ELEMENT FINGERPRINT (as recorded, may all have changed)',
    `  role: ${fingerprint.role}`,
    `  tag: ${fingerprint.tagName}`,
    `  accessible name: ${fingerprint.accessibleName || '(none)'}`,
    `  visible text: ${fingerprint.text || '(none)'}`,
    fingerprint.testId ? `  test id: ${fingerprint.testId}` : '',
    fingerprint.id ? `  id: ${fingerprint.id}` : '',
    fingerprint.inputType ? `  input type: ${fingerprint.inputType}` : '',
    fingerprint.placeholder ? `  placeholder: ${fingerprint.placeholder}` : '',
    `  page context: ${fingerprint.context ?? '(none)'}`,
    fingerprint.nearbyText.length > 0 ? `  nearby text: ${fingerprint.nearbyText.join(' | ')}` : '',
    `  locator that stopped working: ${describeLocator(staleLocator)}`,
    `  failure: ${failureMessage}`,
    '',
    'EXPECTED OUTCOME OF THIS STEP',
    `  ${outcome.intended ?? '(no description recorded)'}`,
    // Every assertion is listed: the candidate will be judged against all of
    // them, so the model should know what the replacement has to achieve.
    outcome.assertions.length === 0
      ? '  checked as: nothing (no post-condition was recordable)'
      : `  checked as: ${outcome.assertions
          .map((a) => (a.value ? `${a.type} "${a.value}"` : a.type))
          .join(' AND ')}`,
    '',
    'CURRENT ELEMENTS ON THE PAGE',
    renderElementsForPrompt(snapshot),
    '',
    'Which element now serves the original intent? List up to 3, best first, or none at all.',
  ]
    .filter(Boolean)
    .join('\n');

  const { data, model } = await generateJson({
    prompt,
    schema: healProposalSchema,
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0,
  });

  return { proposal: healProposalSchema.parse(data), model };
}
