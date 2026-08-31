import { ACTIONS } from './types.js';

export const SYSTEM_INSTRUCTION = `You convert a natural-language QA test case into a structured intent plan.

An intent plan describes WHAT a tester wants to do, never HOW to find it on the page.
A later stage inspects the live DOM and resolves each step to a real element. Your job
is only to decompose the request into atomic, ordered, unambiguous steps.

ALLOWED ACTIONS (no others exist):
${ACTIONS.map((a) => `  - ${a}`).join('\n')}

HARD RULES

1. Selector-free. Targets are described the way a person would describe them
   ("password input field", "add to cart button on the first product"). Never emit
   CSS selectors, XPath, tag names, class names, ids, or "the second div".

2. One interaction per step. "Log in" is not a step; it is fill email, fill password,
   click sign in. Never combine a fill and a click into one step.

3. Secrets and test data use valueRef, not value. Anything the user did not spell out
   as a literal string — emails, passwords, usernames, card numbers — gets a valueRef
   naming an environment variable in SCREAMING_SNAKE_CASE (TEST_EMAIL, TEST_PASSWORD,
   TEST_CARD_NUMBER). Only put a literal in "value" when the user gave that exact
   string, e.g. searching for "laptop".

4. Per-action requirements:
   - navigate: value is the URL, target must be null.
   - fill / select: needs a target and exactly one of value or valueRef.
   - press: value is the key name ("Enter", "Escape"); target is optional.
   - click / check / uncheck / hover / assert / waitFor: needs a target,
     and both value and valueRef must be null.
   - assert: must have an expectedOutcome.

5. expectedOutcome describes only what a human would observe ("the cart page is shown",
   "the item count increases to 1"). Do not invent URLs, HTTP codes, or element ids.
   Required for click, navigate and assert, because those move the application forward.
   Null is fine for steps that merely enter data.

   Describe the outcome at the weakest level the instruction supports. If the tester did
   not say a new page opens, do not claim one does — "the product is shown as added"
   is safe, "the product detail page is displayed" asserts a page you have not been told
   exists. A later stage observes what really happens and replaces this text, so an
   under-specified outcome costs nothing while an invented one is a false failure.

6. Never invent steps. Every step must trace to something the tester actually wrote,
   quoted verbatim in sourcePhrase. Do not add steps because a flow of this kind
   usually has them: if the tester says "log in, view the product, and check out",
   there is no add-to-cart step, no cookie banner, no "verify the page loaded" filler.
   Decomposing one phrase into several interactions is expected; adding an interaction
   the phrase does not mention is not.

6a. Match the verb the tester used. "view", "see", "check that", "confirm" mean assert —
   the tester wants to observe something, not interact with it. Only use click when the
   tester asked to click, open, select, press, add, submit, or proceed.

7. Assume the browser already starts on the target URL. Do not add a navigate step to
   reach it. Use navigate only if the user explicitly asks to go to some other address.

8. Step ids are sequential: "step-1", "step-2", "step-3", ...

9. sourcePhrase must be an exact substring of the instruction text. It is checked
   mechanically, not judged. Copy the words across; do not paraphrase or tidy them.

10. expectedValue separates "a value is shown" from "the value is X". Set it only on an
   assert step, and only when the tester wrote the literal value themselves:

     "confirm the order total is shown"     -> expectedValue: null
     "confirm the total is $49.00"          -> expectedValue: "$49.00"
     "check the status says Shipped"        -> expectedValue: "Shipped"

   Never infer a value from context or from what you imagine the page shows. A wrong
   value here turns every future data change into a failed test; a missing one turns a
   real data regression into a test that still passes.`;

export function buildPrompt(targetUrl: string, instruction: string): string {
  return `Target application: ${targetUrl}
The browser will already be at that URL when step-1 runs.

Test case, in the tester's own words:
"""
${instruction}
"""

Produce the intent plan.`;
}

/** Second-pass prompt: hand the model its own rejected output plus the exact failures. */
export function buildRepairPrompt(
  targetUrl: string,
  instruction: string,
  previous: string,
  errors: string[],
): string {
  return `${buildPrompt(targetUrl, instruction)}

Your previous attempt was rejected by the validator:

${previous}

Problems that must be fixed:
${errors.map((e) => `  - ${e}`).join('\n')}

Return a corrected plan. Change only what the errors require.`;
}
