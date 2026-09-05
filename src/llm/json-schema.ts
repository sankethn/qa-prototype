import { z } from 'zod';

/** Keys Gemini's schema dialect rejects or ignores; stripped recursively. */
const UNSUPPORTED_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'title',
  'default',
  'const',
  'examples',
  'exclusiveMinimum',
  'exclusiveMaximum',
]);

type JsonSchema = Record<string, unknown>;

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== 'object') return node;

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    out[key] = key === 'enum' ? value : sanitize(value);
  }

  // Gemini honours `propertyOrdering` to keep generated fields in a stable order,
  // which measurably improves structured-output quality. Zod emits properties in
  // declaration order, so we just mirror that.
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.propertyOrdering = Object.keys(out.properties as JsonSchema);
  }

  return out;
}

/**
 * Converts a zod schema into the OpenAPI-3.0-flavoured schema Gemini expects.
 *
 * Targeting `openapi-3.0` is deliberate: it emits `nullable: true` rather than
 * `type: [..., "null"]`, and inlines reused subschemas rather than emitting
 * `$defs`/`$ref` — both of which Gemini's dialect wants.
 */
export function toGeminiSchema(schema: z.ZodType): JsonSchema {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'output',
    reused: 'inline',
  });
  return sanitize(jsonSchema) as JsonSchema;
}

/**
 * Keywords OpenAI's strict Structured Outputs mode does not support. Present in
 * a schema they are not ignored — the request is rejected — so our `.min(1)` and
 * `.max(3)` constraints have to be dropped before the call.
 *
 * Losing them costs nothing: they were guidance for the model, and every real
 * constraint is re-checked by the zod parse and the rule validators when the
 * reply comes back.
 */
const OPENAI_UNSUPPORTED_KEYS = new Set([
  '$schema',
  '$id',
  'title',
  'default',
  'examples',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
]);

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== 'object') return node;

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (OPENAI_UNSUPPORTED_KEYS.has(key)) continue;
    out[key] = key === 'enum' ? value : strictify(value);
  }

  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    const keys = Object.keys(out.properties as JsonSchema);
    // Strict mode requires every property to be listed in `required` and
    // forbids extra ones. Optionality is expressed by allowing null instead,
    // which is why our schemas use `.nullable()` rather than `.optional()`
    // throughout — the model must make an explicit "no value" choice.
    out.required = keys;
    out.additionalProperties = false;
  }

  return out;
}

/**
 * Converts a zod schema into the strict JSON Schema OpenAI's Structured Outputs
 * expects.
 *
 * A different dialect from Gemini's, hence a separate function: OpenAI wants
 * draft-2020-12 with `type: [..., "null"]` unions, every property required and
 * `additionalProperties: false` everywhere, and it rejects the length and range
 * keywords Gemini merely ignores.
 */
export function toOpenAiSchema(schema: z.ZodType): JsonSchema {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'output',
    reused: 'inline',
  });
  return strictify(jsonSchema) as JsonSchema;
}
