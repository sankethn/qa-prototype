import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../config.js';
import { storedPlanSchema, type IntentPlan, type StoredPlan } from '../intent/types.js';

/**
 * Flat JSON files on disk, keyed by planId — no database for the prototype.
 * Stage 2 looks a baseline up by the same planId, so the id has to be stable
 * across regenerations, which is why it is derived from the plan name.
 */

export function toPlanId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unnamed-plan';
}

function planPath(planId: string): string {
  return path.join(PATHS.plans, `${planId}.json`);
}

export async function savePlan(params: {
  plan: IntentPlan;
  model: string;
  targetUrl: string;
  instruction: string;
  planId?: string;
}): Promise<{ planId: string; filePath: string; stored: StoredPlan }> {
  const planId = params.planId ?? toPlanId(params.plan.name);
  const stored: StoredPlan = {
    planId,
    createdAt: new Date().toISOString(),
    model: params.model,
    source: { targetUrl: params.targetUrl, instruction: params.instruction },
    plan: params.plan,
  };

  await fs.mkdir(PATHS.plans, { recursive: true });
  const filePath = planPath(planId);
  await fs.writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

  return { planId, filePath, stored };
}

export async function loadPlan(planId: string): Promise<StoredPlan | null> {
  try {
    const raw = await fs.readFile(planPath(planId), 'utf8');
    return storedPlanSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listPlans(): Promise<string[]> {
  try {
    const files = await fs.readdir(PATHS.plans);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
