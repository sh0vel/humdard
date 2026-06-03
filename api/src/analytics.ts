/**
 * Cloudflare Analytics Engine helpers.
 *
 * Dataset layout (column positions are fixed — don't reorder):
 *
 *  api_request
 *    indexes[0] = endpoint (normalised, e.g. /api/songs/:id)
 *    blobs[0]   = event_type ("api_request")
 *    blobs[1]   = endpoint
 *    blobs[2]   = method
 *    doubles[0] = status_code
 *    doubles[1] = wall_ms
 *
 *  openai_call
 *    indexes[0] = schema_name (e.g. "tokens", "translation_direct")
 *    blobs[0]   = event_type ("openai_call")
 *    blobs[1]   = schema_name
 *    blobs[2]   = model
 *    doubles[0] = wall_ms
 *    doubles[1] = prompt_tokens
 *    doubles[2] = completion_tokens
 *    doubles[3] = success (1 = ok, 0 = error)
 *
 *  generation
 *    indexes[0] = status ("done" | "error")
 *    blobs[0]   = event_type ("generation")
 *    blobs[1]   = status
 *    blobs[2]   = title
 *    blobs[3]   = artist
 *    blobs[4]   = error_message (empty string when ok)
 *    blobs[5]   = target_lang (e.g. "hi")
 *    blobs[6]   = learner_lang (e.g. "en")
 *    doubles[0] = wall_ms           (total job time)
 *    doubles[1] = phase_base_ms     (Phase 1: structure + script)
 *    doubles[2] = phase_parallel_ms (Phase 2: translations + tokens in parallel)
 *    doubles[3] = total_lines
 *    doubles[4] = unique_lines      (after chorus dedup)
 *    doubles[5] = prompt_tokens
 *    doubles[6] = completion_tokens
 *    doubles[7] = cost_usd
 *    doubles[8] = error_count       (partial failures in generationErrors)
 *
 * Example SQL (Cloudflare Analytics Engine):
 *   SELECT blob3 AS title, SUM(_sample_interval * double7) AS cost_usd
 *   FROM humdard
 *   WHERE blob1 = 'generation' AND blob2 = 'done'
 *   GROUP BY title
 *   ORDER BY cost_usd DESC
 */

import { Env } from './types';

function write(env: Env, data: AnalyticsEngineDataPoint): void {
  try {
    env.ANALYTICS?.writeDataPoint(data);
  } catch {
    // Analytics must never break callers
  }
}

// Normalise a raw request path so IDs don't pollute dimension cardinality.
export function normalizeEndpoint(path: string): string {
  return path
    .replace(/\/api\/songs\/[^/]+\/lines\/[^/]+\/retranslate$/, '/api/songs/:id/lines/:id/retranslate')
    .replace(/\/api\/songs\/[^/]+\/lines\/[^/]+\/instrumental$/, '/api/songs/:id/lines/:id/instrumental')
    .replace(/\/api\/songs\/[^/]+\/lines\/[^/]+$/, '/api/songs/:id/lines/:id')
    .replace(/\/api\/songs\/[^/]+\/retranslate$/, '/api/songs/:id/retranslate')
    .replace(/\/api\/songs\/[^/]+$/, '/api/songs/:id')
    .replace(/\/api\/jobs\/[^/]+$/, '/api/jobs/:id');
}

export interface ApiRequestEvent {
  endpoint: string; // already normalised
  method: string;
  statusCode: number;
  wallMs: number;
}

export interface OpenAICallEvent {
  schemaName: string;
  model: string;
  wallMs: number;
  promptTokens: number;
  completionTokens: number;
  success: boolean;
}

export interface GenerationEvent {
  status: 'done' | 'error';
  title: string;
  artist: string;
  errorMessage?: string;
  targetLang: string;
  learnerLang: string;
  wallMs: number;
  phaseBaseMs: number;
  phaseParallelMs: number;
  totalLines: number;
  uniqueLines: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  errorCount: number;
}

export function trackApiRequest(env: Env, event: ApiRequestEvent): void {
  write(env, {
    blobs: ['api_request', event.endpoint, event.method],
    doubles: [event.statusCode, event.wallMs],
    indexes: [event.endpoint],
  });
}

export function trackOpenAICall(env: Env, event: OpenAICallEvent): void {
  write(env, {
    blobs: ['openai_call', event.schemaName, event.model],
    doubles: [event.wallMs, event.promptTokens, event.completionTokens, event.success ? 1 : 0],
    indexes: [event.schemaName],
  });
}

export function trackGeneration(env: Env, event: GenerationEvent): void {
  write(env, {
    blobs: ['generation', event.status, event.title, event.artist, event.errorMessage ?? '', event.targetLang, event.learnerLang],
    doubles: [event.wallMs, event.phaseBaseMs, event.phaseParallelMs, event.totalLines, event.uniqueLines, event.promptTokens, event.completionTokens, event.costUsd, event.errorCount],
    indexes: [event.status],
  });
}
