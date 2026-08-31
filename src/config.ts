import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PATHS = {
  plans: path.join(ROOT, 'data', 'plans'),
  baselines: path.join(ROOT, 'data', 'baselines'),
  runs: path.join(ROOT, 'data', 'runs'),
} as const;

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.7-flash';

export function requireApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set. Copy env.example to .env and add your key.');
  }
  return key;
}

/**
 * Resolves a plan's `valueRef` (e.g. "TEST_EMAIL") to a real value at execution time.
 * Secrets live only in the environment; a stored plan holds the name, never the value.
 */
export function resolveValueRef(ref: string): string {
  const value = process.env[ref];
  if (value === undefined) {
    throw new Error(`Plan references ${ref} but it is not set in the environment.`);
  }
  return value;
}
