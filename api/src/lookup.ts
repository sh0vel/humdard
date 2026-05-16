/**
 * Lyric lookup orchestrator.
 *
 * Pipeline:
 *   Stage 1: Parallel scrapers (LyricsDex, LyricsRaag, Genius)
 *   ↓
 *   ⚡ Short-circuit if any scraper returned native script (Devanagari etc.) > 100 chars
 *   ↓
 *   Roman fallback: return the longest Roman result directly.
 *   jsonify handles Roman → Devanagari conversion in one pass.
 */

import {
  RawLyricResult,
  searchLyricsDex,
  searchLyricsRaag,
  searchGenius,
} from './scrapers';
import { Env } from './types';

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

/**
 * Main entry. Called from index.ts → handleLookup.
 */
export async function lookupLyrics(
  _env: Env,
  title: string,
  artist?: string
): Promise<LookupResult> {
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
    `[lookup] scrapers: ${results.length} results —`,
    results.map((r) => `${r.source}(${r.detectedScript ?? 'roman'}, ${r.rawText.length}c)`)
  );

  if (results.length === 0) return { candidates: [] };

  // ⚡ Short-circuit: native script found — return immediately, no AI needed.
  const nativeHit = results.find((r) => r.detectedScript && r.rawText.length > 100);
  if (nativeHit) {
    console.log(`[lookup] ⚡ short-circuit: ${nativeHit.source} ${nativeHit.detectedScript}`);
    return {
      candidates: [{
        title:      nativeHit.title  || title,
        artist:     nativeHit.artist || artist || '',
        devanagari: nativeHit.rawText,
        confidence: 'high',
        notes:      `via ${nativeHit.source}.com (${nativeHit.detectedScript})`,
      }],
    };
  }

  // Roman-only fallback: pick the longest result and pass it straight to jsonify.
  // jsonify's system prompt handles Roman → Devanagari conversion in one pass.
  const best = results.reduce((a, b) => (b.rawText.length > a.rawText.length ? b : a));
  if (best.rawText.length < 50) return { candidates: [] };

  console.log(`[lookup] Roman fallback: ${best.source} (${best.rawText.length}c)`);
  return {
    candidates: [{
      title:      best.title  || title,
      artist:     best.artist || artist || '',
      devanagari: best.rawText,
      confidence: 'medium',
      notes:      `Roman via ${best.source}.com`,
    }],
  };
}
