import { z } from 'zod';
import { locatorSchema } from '../baseline/types.js';

/**
 * What the model returns when asked to find a replacement element.
 *
 * `candidate` is nullable and that is a first-class answer, not an error path.
 * A healer that always finds something would eventually rewrite a test to point
 * at whatever happens to be on the page.
 */
export const healCandidateSchema = z.object({
  ref: z
    .string()
    .describe('The ref of a candidate element, exactly as shown in brackets (e.g. "s3e7").'),
  confidence: z
    .number()
    .describe(
      '0 to 1. How certain you are that this element serves the SAME purpose as the ' +
        'element described by the fingerprint. Be strict: a plausible-looking button ' +
        'that does something different should score low.',
    ),
  reason: z.string().describe('One sentence explaining the equivalence.'),
});

export const healProposalSchema = z.object({
  candidates: z
    .array(healCandidateSchema)
    .max(3)
    .describe(
      'Up to 3 candidates, best first. An EMPTY list is the correct answer when nothing ' +
        'on the page serves the original intent — a removed feature or a different screen. ' +
        'Only include a second or third candidate if it is genuinely plausible; padding the ' +
        'list with weak guesses means they will actually be executed against the application.',
    ),
  reason: z
    .string()
    .describe('One sentence on the overall judgement, especially if the list is empty.'),
});

export type HealProposal = z.infer<typeof healProposalSchema>;

export const HEAL_STATUSES = [
  /** Proposed, executed, and the original outcome held. The test is updated. */
  'accepted',
  /** Proposed and executed, but the original outcome did not hold. */
  'rejected',
  /** Confidence was below the gate; nothing was executed. */
  'below_threshold',
  /** The model declined to propose anything. */
  'no_candidate',
  /** A candidate was proposed but no unique locator could be derived for it. */
  'unlocatable',
  /** Executing the candidate threw. */
  'execution_failed',
] as const;

export type HealCandidate = z.infer<typeof healCandidateSchema>;

export const healAttemptSchema = z.object({
  stepId: z.string(),
  status: z.enum(HEAL_STATUSES),
  confidence: z.number(),
  reason: z.string(),
  threshold: z.number(),
  model: z.string(),
  previousLocator: locatorSchema,
  newLocator: locatorSchema.nullable(),
  /** What the outcome check saw, whether it passed or failed. */
  verification: z.string(),
  /** How many the model offered, and how many were actually executed. */
  candidatesProposed: z.number(),
  candidatesTried: z.number(),
});

export type HealAttempt = z.infer<typeof healAttemptSchema>;

// Defined alongside the baseline it is written into, and re-exported here so
// healing code has one import for its own types.
export { healRecordSchema, type HealRecord } from '../baseline/types.js';
