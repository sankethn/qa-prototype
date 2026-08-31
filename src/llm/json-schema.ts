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
