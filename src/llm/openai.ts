import OpenAI from 'openai';
import type { z } from 'zod';
import { OPENAI_MODEL, requireOpenAiKey } from '../config.js';
import { toOpenAiSchema } from './json-schema.js';

let client: OpenAI | undefined;

function getClient(): OpenAI {
  client ??= new OpenAI({ apiKey: requireOpenAiKey() });
  return client;
}

/** Reasoning models reject `temperature`; only the default is accepted. */
function supportsTemperature(model: string): boolean {
  return /^(gpt-4|gpt-3|chatgpt-4)/.test(model);
}

export interface GenerateJsonOptions {
  prompt: string;
  schema: z.ZodType;
  systemInstruction?: string;
  model?: string;
  /**
   * Low by default: this is extraction, not creative writing.
   *
   * Only sent to models that accept it. GPT-5 and later reject the parameter
   * outright rather than clamping it, so for those the equivalent intent — do
   * not muse, just extract — is expressed as a low reasoning effort instead.
   */
  temperature?: number;
  /** Reasoning effort for models that take it. */
  effort?: 'none' | 'low' | 'medium' | 'high';
  /** Schema name required by the API. Letters, digits, underscore and dash only. */
  schemaName?: string;
}

export interface GenerateJsonResult {
  data: unknown;
  raw: string;
  model: string;
}

/**
 * One structured-output call, interface-identical to the Gemini wrapper so the
 * two are swappable at the import.
 *
 * `strict: true` constrains decoding, so the reply is always syntactically
 * valid JSON in the right shape. Semantic validation (zod parse + the per-action
 * rules) still happens on our side afterwards — the schema constrains form, not
 * meaning.
 */
export async function generateJson({
  prompt,
  schema,
  systemInstruction,
  model = OPENAI_MODEL,
  temperature = 0.1,
  effort = 'low',
  schemaName = 'response',
}: GenerateJsonOptions): Promise<GenerateJsonResult> {
  const response = await getClient().responses.create({
    model,
    input: [
      ...(systemInstruction
        ? [{ role: 'system' as const, content: systemInstruction }]
        : []),
      { role: 'user' as const, content: prompt },
    ],
    ...(supportsTemperature(model) ? { temperature } : { reasoning: { effort } }),
    text: {
      format: {
        type: 'json_schema',
        name: schemaName,
        strict: true,
        schema: toOpenAiSchema(schema),
      },
    },
  });

  // A refusal comes back as its own output part rather than an error, and would
  // otherwise surface as unexplained empty text.
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'refusal') {
        throw new Error(`OpenAI refused the request: ${part.refusal}`);
      }
    }
  }

  const text = response.output_text;
  if (!text) {
    // Reasoning models can also stop on the output-token cap before emitting
    // any JSON, which is worth naming rather than reporting as "empty".
    const status = response.incomplete_details?.reason;
    throw new Error(
      status
        ? `OpenAI returned no output (incomplete: ${status}).`
        : 'OpenAI returned an empty response.',
    );
  }

  try {
    return { data: JSON.parse(text) as unknown, raw: text, model };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAI returned unparseable JSON: ${message}\n${text.slice(0, 500)}`);
  }
}
