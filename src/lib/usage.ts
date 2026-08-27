// Usage aggregation for the admin Settings screen. Token/cost details stay
// out of the everyday workflow by design.

import { db } from './db';
import type { UsageKind } from './types';

export interface UsageSummary {
  reelsGenerated: number;
  exports: number;
  aiCalls: number;
  analysisRuns: number;
  estimatedAiCostUsd: number;
}

// Rough per-call cost of one batched vision analysis request (small images,
// short structured response). Displayed as an estimate only.
const EST_COST_PER_AI_CALL = 0.02;

export async function summarizeUsage(sinceMs = 0): Promise<UsageSummary> {
  const events = await db.usage.where('at').above(sinceMs).toArray();
  const count = (kind: UsageKind) => events.filter((e) => e.kind === kind).length;
  const aiCalls = count('ai-call');
  return {
    reelsGenerated: count('reel-created'),
    exports: count('export'),
    aiCalls,
    analysisRuns: count('analysis'),
    estimatedAiCostUsd: aiCalls * EST_COST_PER_AI_CALL,
  };
}
