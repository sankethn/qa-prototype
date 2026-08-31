import type { Browser, Page } from 'playwright';
import { launchBrowser, newPage } from '../browser/session.js';
import { resolveValueRef } from '../config.js';
import { extractPage, type ExtractedElement, type PageSnapshot } from '../browser/extract.js';
import { executeAction, isReadOnly, settle } from '../browser/execute.js';
import { toFingerprint } from '../browser/fingerprint.js';
import { buildLocator, describeLocator, resolveLocators } from '../browser/locator.js';
import { actsOnElement, type IntentPlan, type IntentStep } from '../intent/types.js';
import type { ResolvedLocators } from '../browser/locator.js';
import { deriveOutcome } from './outcome.js';
import { resolveStep } from './resolve.js';
import type { Baseline, BaselineStep } from './types.js';

/** Below this, the model is guessing and we would be baking a guess into a baseline. */
export const RESOLUTION_THRESHOLD = 0.7;

export interface GenerateBaselineOptions {
  planId: string;
  plan: IntentPlan;
  headed?: boolean;
  threshold?: number;
  onEvent?: (event: BaselineEvent) => void;
}

export type BaselineEvent =
  | { type: 'page'; url: string; elementCount: number; truncated: boolean }
  | { type: 'resolved'; stepId: string; ref: string | null; confidence: number; reason: string }
  | { type: 'locator'; stepId: string; locator: string; fallbacks: number }
  | { type: 'executed'; stepId: string; outcome: string }
  | { type: 'warning'; stepId: string; message: string };

/**
 * Walks the plan against the live application, recording a baseline as it goes.
 *
 * Resolution is per-step rather than per-page on purpose. Step N's page only
 * exists once step N-1 has run, so executing each step *is* how we navigate to
 * the next one — baseline generation is a real run, not a static analysis. It
 * also means a failure is attributable to exactly one step.
 */
export async function generateBaseline({
  planId,
  plan,
  headed = false,
  threshold = RESOLUTION_THRESHOLD,
  onEvent,
}: GenerateBaselineOptions): Promise<Baseline> {
  const browser: Browser = await launchBrowser({ headed });
  const page: Page = await newPage(browser);

  try {
    await page.goto(plan.startUrl, { waitUntil: 'domcontentloaded' });
    await settle(page);

    const steps: BaselineStep[] = [];
    const history: string[] = [];
    let snapshot = await extractPage(page);
    let model = '';

    onEvent?.({
      type: 'page',
      url: snapshot.url,
      elementCount: snapshot.elements.length,
      truncated: snapshot.truncated,
    });

    for (const step of plan.steps) {
      // `navigate` acts on the page, not an element, so there is nothing to
      // resolve. Asking the model to match one anyway would have it pick some
      // arbitrary element and store a locator the step never uses.
      const needsElement = actsOnElement(step.action);

      let element: ExtractedElement | null = null;
      let resolved: ResolvedLocators | null = null;
      let resolution = { confidence: 1, reason: 'Acts on the page, not an element.' };

      if (needsElement) {
        const matched = await resolveElement({ step, snapshot, history, threshold, onEvent });
        model = matched.model;
        element = matched.element;
        resolution = matched.resolution;

        resolved = await resolveLocators(page, element);
        if (!resolved) {
          throw new BaselineError(
            step,
            `Matched element [${element.ref}] (${element.role} "${element.accessibleName}") but ` +
              'could not derive a locator that uniquely selects it. The element has no test id, ' +
              'accessible name, label or stable id to anchor on.',
          );
        }

        onEvent?.({
          type: 'locator',
          stepId: step.id,
          locator: describeLocator(resolved.primary),
          fallbacks: resolved.fallbacks.length,
        });
      }

      const value = step.valueRef ? resolveValueRef(step.valueRef) : step.value;
      const urlBefore = page.url();

      try {
        await executeAction({
          page,
          action: step.action,
          locator: resolved ? buildLocator(page, resolved.primary) : null,
          value,
        });
      } catch (err) {
        throw new BaselineError(step, `Executing the step failed: ${messageOf(err)}`);
      }

      if (!isReadOnly(step.action)) await settle(page);

      const after = await extractPage(page);
      const outcome = await deriveOutcome({
        page,
        action: step.action,
        stepLocator: resolved?.primary ?? null,
        intended: step.expectedOutcome?.description ?? null,
        urlBefore,
        urlAfter: page.url(),
        before: snapshot,
        after,
      });

      if (outcome.type === 'none') {
        onEvent?.({
          type: 'warning',
          stepId: step.id,
          message:
            'Nothing observable changed, so this step has no post-condition. A failure here ' +
            'will be detectable but a heal cannot be verified against it.',
        });
      }

      steps.push({
        stepId: step.id,
        intent: step.intent,
        action: step.action,
        value: step.value,
        valueRef: step.valueRef,
        pageUrl: urlBefore,
        locator: resolved?.primary ?? null,
        fallbackLocators: resolved?.fallbacks ?? [],
        fingerprint: element ? toFingerprint(element) : null,
        expectedOutcome: outcome,
        resolution: { confidence: resolution.confidence, reason: resolution.reason },
        healHistory: [],
      });

      onEvent?.({ type: 'executed', stepId: step.id, outcome: describeOutcome(outcome) });

      history.push(`${step.id}: ${step.intent}`);
      if (page.url() !== snapshot.url) {
        onEvent?.({
          type: 'page',
          url: after.url,
          elementCount: after.elements.length,
          truncated: after.truncated,
        });
      }
      snapshot = after;
    }

    return {
      baselineId: planId,
      planId,
      createdAt: new Date().toISOString(),
      model,
      startUrl: plan.startUrl,
      steps,
    };
  } finally {
    await browser.close();
  }
}

async function resolveElement({
  step,
  snapshot,
  history,
  threshold,
  onEvent,
}: {
  step: IntentStep;
  snapshot: PageSnapshot;
  history: string[];
  threshold: number;
  onEvent?: (event: BaselineEvent) => void;
}): Promise<{ element: ExtractedElement; resolution: { confidence: number; reason: string }; model: string }> {
  const { resolution, model } = await resolveStep({ step, snapshot, history });

  onEvent?.({
    type: 'resolved',
    stepId: step.id,
    ref: resolution.ref,
    confidence: resolution.confidence,
    reason: resolution.reason,
  });

  if (resolution.ref === null) {
    throw new BaselineError(
      step,
      `No element on ${snapshot.url} matches this step. Model said: ${resolution.reason}`,
    );
  }

  if (resolution.confidence < threshold) {
    throw new BaselineError(
      step,
      `Best match [${resolution.ref}] scored ${resolution.confidence.toFixed(2)}, below the ` +
        `${threshold} threshold. Model said: ${resolution.reason}`,
    );
  }

  const element = snapshot.elements.find((el) => el.ref === resolution.ref);
  if (!element) {
    throw new BaselineError(step, `Model returned ref "${resolution.ref}", which is not on the page.`);
  }

  return { element, resolution, model };
}

function describeOutcome(outcome: { type: string; value: string | null }): string {
  return outcome.value ? `${outcome.type} "${outcome.value}"` : outcome.type;
}

export class BaselineError extends Error {
  constructor(
    readonly step: IntentStep,
    message: string,
  ) {
    super(`${step.id} (${step.action}) — ${message}`);
    this.name = 'BaselineError';
  }
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split('\n')[0] ?? raw;
}
