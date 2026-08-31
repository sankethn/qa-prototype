import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import type { RunResult } from '../run/types.js';

/** Runs accumulate rather than overwrite — the history is the point. */
export async function saveRun(run: RunResult): Promise<string> {
  await fs.mkdir(PATHS.runs, { recursive: true });
  const filePath = path.join(PATHS.runs, `${run.runId}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  return filePath;
}
