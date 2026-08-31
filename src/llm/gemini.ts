import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import { GEMINI_MODEL, requireApiKey } from '../config.js';
import { toGeminiSchema } from './json-schema.js';

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: requireApiKey() });
  return client;
}

export interface GenerateJsonOptions {
  prompt: string;
  schema: z.ZodType;
  systemInstruction?: string;
  model?: string;
  /** Low by default: this is extraction, not creative writing. */
  temperature?: number;
}

export interface GenerateJsonResult {
  data: unknown;
  raw: string;
  model: string;
}

/**
 * One structured-output call. `responseSchema` constrains decoding, so the reply
 * is always syntactically valid JSON in the right shape. Semantic validation
 * (zod parse + the per-action rules) still happens on our side afterwards —
 * the schema constrains form, not meaning.
 */
export async function generateJson({
  prompt,
  schema,
  systemInstruction,
  model = GEMINI_MODEL,
  temperature = 0.1,
}: GenerateJsonOptions): Promise<GenerateJsonResult> {
  const response = await getClient().models.generateContent({
    model,
    contents: prompt,
    config: {
      ...(systemInstruction ? { systemInstruction } : {}),
      temperature,
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(schema),
    },
  });

  const text = response.text;
  if (!text) throw new Error('Gemini returned an empty response.');

  try {
    return { data: JSON.parse(text) as unknown, raw: text, model };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Gemini returned unparseable JSON: ${message}\n${text.slice(0, 500)}`);
  }
}
