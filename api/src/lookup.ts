/**
 * Lyric lookup orchestrator.
 *
 * Pipeline:
 *   Stage 1: Parallel scrapers (LyricsDex, LyricsRaag, Genius)
 *   ↓
 *   ⚡ Short-circuit if any scraper returned Devanagari with > 100 chars
 *   ↓
 *   Stage 2: AI normalize the deduped scraped texts (Chat Completions)
 *   ↓
 *   (if all scrapers returned null) → return empty candidates
 */

import { Env } from './types';
import {
  RawLyricResult,
  searchLyricsDex,
  searchLyricsRaag,
  searchGenius,
} from './scrapers';
import {
  LOOKUP_SCHEMA,
  stage2SystemPrompt,
  stage2UserPrompt,
} from './lookup-prompts';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-5.2';

export interface LookupCandidate {
  title: string;
  artist: string;
  devanagari: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

export interface LookupResult {
  candidates: LookupCandidate[];
}

function filterValidCandidates(candidates: LookupCandidate[]): LookupCandidate[] {
  // Only drop genuinely empty results — Roman is OK, jsonify will transliterate.
  return candidates.filter((c) => c.devanagari && c.devanagari.trim().length > 20);
}

function dedupForAI(results: RawLyricResult[]): RawLyricResult[] {
  // Keep the longest text per script (native scripts grouped by their type;
  // Roman texts grouped together).
  const byScript = new Map<string, RawLyricResult>();
  for (const r of results) {
    const key = r.detectedScript ?? 'roman';
    const existing = byScript.get(key);
    if (!existing || r.rawText.length > existing.rawText.length) {
      byScript.set(key, r);
    }
  }
  return Array.from(byScript.values());
}

/**
 * Main entry. Called from index.ts → handleLookup.
 */
export async function lookupLyrics(
  env: Env,
  title: string,
  artist?: string
): Promise<LookupResult> {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set in environment');
  }

  // Stage 1: parallel scrapers
  const settled = await Promise.allSettled([
    searchLyricsDex(title, artist),
    searchLyricsRaag(title, artist),
    searchGenius(title, artist),
  ]);

  const results: RawLyricResult[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) results.push(s.value);
  }

  console.log(
    `[lookup] scrapers returned ${results.length} non-null results:`,
    results.map((r) => `${r.source}(${r.detectedScript ?? 'roman'}, ${r.rawText.length}c)`)
  );

  if (results.length === 0) {
    console.log('[lookup] all scrapers missed — returning empty');
    return { candidates: [] };
  }

  // Short-circuit: native-script hit with enough text — skip AI entirely.
  const nativeHit = results.find((r) => r.detectedScript && r.rawText.length > 100);
  if (nativeHit) {
    console.log(`[lookup] ⚡ short-circuit: ${nativeHit.source} ${nativeHit.detectedScript}, skipping AI`);
    return {
      candidates: [
        {
          title: nativeHit.title || title,
          artist: nativeHit.artist || artist || '',
          devanagari: nativeHit.rawText,
          confidence: 'high',
          notes: `via ${nativeHit.source}.com (${nativeHit.detectedScript})`,
        },
      ],
    };
  }

  // Stage 2: dedupe and send to AI for transliteration/normalization.
  const deduped = dedupForAI(results);
  console.log(`[lookup] Stage 2 normalize: ${deduped.length} deduped excerpts`);
  const stage2Result = await stage2Normalize(env, title, artist, deduped);

  // If Stage 2 returned nothing (transliteration failed), fall back to raw Roman text.
  if (stage2Result.candidates.length === 0) {
    const romanHit = results.find((r) => r.rawText.length > 50);
    if (romanHit) {
      console.log(`[lookup] Stage 2 empty — returning raw Roman from ${romanHit.source}`);
      return {
        candidates: [
          {
            title: romanHit.title || title,
            artist: romanHit.artist || artist || '',
            devanagari: romanHit.rawText,
            confidence: 'low',
            notes: `Roman from ${romanHit.source}.com — jsonify will transliterate`,
          },
        ],
      };
    }
  }

  return stage2Result;
}

/**
 * Stage 2: send deduped scraped texts to GPT-5.5 for normalization.
 */
async function stage2Normalize(
  env: Env,
  title: string,
  artist: string | undefined,
  excerpts: RawLyricResult[]
): Promise<LookupResult> {
  const model = env.OPENAI_MODEL || DEFAULT_MODEL;

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: stage2SystemPrompt() },
      { role: 'user', content: stage2UserPrompt(title, artist, excerpts) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'lyric_lookup',
        strict: true,
        schema: LOOKUP_SCHEMA,
      },
    },
    // GPT-5.5 only supports default temperature; do not set it.
  };

  const response = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[lookup] Stage 2 OpenAI error:', response.status, errorText);
    if (response.status === 429) {
      // Rate limited — return empty so the caller can fall back to raw Roman text.
      console.warn('[lookup] Stage 2 rate limited, falling back to raw scraped text');
      return { candidates: [] };
    }
    throw new Error(`OpenAI Stage 2 error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices?: { message: { content?: string; refusal?: string | null } }[];
  };
  const choice = data.choices?.[0];
  if (!choice) throw new Error('No choices returned from OpenAI Stage 2');
  if (choice.message.refusal) throw new Error(`OpenAI refused: ${choice.message.refusal}`);
  const content = choice.message.content;
  if (!content) throw new Error('No content in OpenAI Stage 2 response');

  const parsed = JSON.parse(content) as LookupResult;
  return { candidates: filterValidCandidates(parsed.candidates || []) };
}
