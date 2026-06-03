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
 *    blobs[7]   = type ("fresh" | "retranslate")
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
 *  retranslate_line
 *    indexes[0] = status ("done" | "error")
 *    blobs[0]   = event_type ("retranslate_line")
 *    blobs[1]   = status
 *    blobs[2]   = song_id
 *    blobs[3]   = line_id
 *    blobs[4]   = has_feedback ("true" | "false")
 *    doubles[0] = wall_ms
 *
 *  lookup
 *    indexes[0] = source ("lyricsdex" | "lyricsraag" | "genius" | "youtube" | "none")
 *    blobs[0]   = event_type ("lookup")
 *    blobs[1]   = source
 *    blobs[2]   = script ("Devanagari" | "Gurmukhi" | "Arabic" | "roman" | "none")
 *    blobs[3]   = title
 *    doubles[0] = wall_ms
 *    doubles[1] = found (1 = candidates returned, 0 = empty)
 *
 * Example SQL (Cloudflare Analytics Engine):
 *   -- Cost by title
 *   SELECT blob3 AS title, SUM(_sample_interval * double8) AS cost_usd
 *   FROM humdard WHERE blob1 = 'generation' AND blob2 = 'done'
 *   GROUP BY title ORDER BY cost_usd DESC
 *
 *   -- Lookup source success rate
 *   SELECT blob2 AS source, round(100 * avg(double2), 1) AS hit_rate
 *   FROM humdard WHERE blob1 = 'lookup' GROUP BY source
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
    .replace(/\/api\/v1\/songs\/[^/]+\/lines\/[^/]+\/retranslate$/, '/api/v1/songs/:id/lines/:id/retranslate')
    .replace(/\/api\/v1\/songs\/[^/]+\/lines\/[^/]+\/instrumental$/, '/api/v1/songs/:id/lines/:id/instrumental')
    .replace(/\/api\/v1\/songs\/[^/]+\/lines\/[^/]+$/, '/api/v1/songs/:id/lines/:id')
    .replace(/\/api\/v1\/songs\/[^/]+\/retranslate$/, '/api/v1/songs/:id/retranslate')
    .replace(/\/api\/v1\/songs\/[^/]+$/, '/api/v1/songs/:id')
    .replace(/\/api\/v1\/jobs\/[^/]+$/, '/api/v1/jobs/:id');
}

// Parse the source name and script from a lookup candidate notes string.
// Examples: "via lyricsdex.com (Devanagari)", "Roman via genius.com", "via youtube (roman)"
export function parseLookupSource(notes: string): { source: string; script: string } {
  const srcMatch = notes.match(/via\s+([a-zA-Z]+)/i);
  const source = srcMatch ? srcMatch[1].toLowerCase() : 'none';
  const scriptMatch = notes.match(/\(([^)]+)\)/);
  const script = scriptMatch
    ? scriptMatch[1]
    : notes.toLowerCase().startsWith('roman') ? 'roman' : 'native';
  return { source, script };
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
  type: 'fresh' | 'retranslate';
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

export interface RetranslateLineEvent {
  status: 'done' | 'error';
  songId: string;
  lineId: string;
  hasFeedback: boolean;
  wallMs: number;
}

export interface LookupEvent {
  source: string;
  script: string;
  title: string;
  found: boolean;
  wallMs: number;
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
    blobs: ['generation', event.status, event.title, event.artist, event.errorMessage ?? '', event.targetLang, event.learnerLang, event.type],
    doubles: [event.wallMs, event.phaseBaseMs, event.phaseParallelMs, event.totalLines, event.uniqueLines, event.promptTokens, event.completionTokens, event.costUsd, event.errorCount],
    indexes: [event.status],
  });
}

export function trackRetranslateLine(env: Env, event: RetranslateLineEvent): void {
  write(env, {
    blobs: ['retranslate_line', event.status, event.songId, event.lineId, event.hasFeedback ? 'true' : 'false'],
    doubles: [event.wallMs],
    indexes: [event.status],
  });
}

export function trackLookup(env: Env, event: LookupEvent): void {
  write(env, {
    blobs: ['lookup', event.source, event.script, event.title],
    doubles: [event.wallMs, event.found ? 1 : 0],
    indexes: [event.source],
  });
}
