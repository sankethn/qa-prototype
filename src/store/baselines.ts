import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { baselineSchema, type Baseline } from '../baseline/types.js';

/**
 * Baselines are keyed by planId, so stage 3 can ask "do we already have one?"
 * and skip generation entirely on the second run.
 */

function baselinePath(planId: string): string {
  return path.join(PATHS.baselines, `${planId}.json`);
}

export async function saveBaseline(baseline: Baseline): Promise<string> {
  await fs.mkdir(PATHS.baselines, { recursive: true });
  const filePath = baselinePath(baseline.planId);
  await fs.writeFile(filePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return filePath;
}

export async function loadBaseline(planId: string): Promise<Baseline | null> {
  try {
    const raw = await fs.readFile(baselinePath(planId), 'utf8');
    return baselineSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
