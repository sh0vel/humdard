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
function stripResidualHtml(text: string): string {
  const TAG_RE = /<(?:"[^"]*"|'[^']*'|[^>])*>/g;
  return text
    .replace(/<br(?:"[^"]*"|'[^']*'|[^>])*>/gi, '\n')
    .replace(/<\/(?:p|div|span|li|td|tr)[^>]*>/gi, '\n')
    .replace(TAG_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanTitle(title: string): string {
  return title
    // "(From 'Movie')" / "(From "Movie")" / "(From Movie)"
    .replace(/\(\s*from\s+['"]?[^)]+['"]?\)/gi, '')
    // " - From 'Movie'" at end of string
    .replace(/\s*[-–]\s*from\s+['"]?.+['"]?\s*$/gi, '')
    // "(feat. ...)" / "(ft. ...)" / "[feat. ...]"
    .replace(/[\[(]\s*f(?:ea)?t\.?\s+[^\])\n]+[\])]/gi, '')
    // trailing noise: "(Official Video)", "(Audio)", "(Lyrical)", "(Title Track)", "(OST)" etc.
    .replace(/\(\s*(?:official|audio|video|lyric(?:al)?|title\s+track|ost|soundtrack|full\s+song)[^)]*\)/gi, '')
    .trim();
}

export async function lookupLyrics(
  _env: Env,
  title: string,
  artist?: string
): Promise<LookupResult> {
  title = cleanTitle(title);
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
  // Require artist overlap when an artist is known, to avoid wrong-song matches.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const artistWords = artist ? normalize(artist).split(/\s+/).filter((w) => w.length >= 2) : [];
  const nativeHit = results.find((r) => {
    if (!r.detectedScript || r.rawText.length <= 100) return false;
    if (artistWords.length > 0 && r.artist) {
      const foundWords = normalize(r.artist).split(/\s+/).filter((w) => w.length >= 2);
      if (!artistWords.some((w) => foundWords.some((fw) => fw.includes(w) || w.includes(fw)))) return false;
    }
    return true;
  });
  if (nativeHit) {
    console.log(`[lookup] ⚡ short-circuit: ${nativeHit.source} ${nativeHit.detectedScript}`);
    return {
      candidates: [{
        title:      nativeHit.title  || title,
        artist:     nativeHit.artist || artist || '',
        devanagari: stripResidualHtml(nativeHit.rawText),
        confidence: 'high',
        notes:      `via ${nativeHit.source}.com (${nativeHit.detectedScript})`,
      }],
    };
  }

  // Roman-only fallback: pick the longest result and pass it straight to jsonify.
  const best = results.reduce((a, b) => (b.rawText.length > a.rawText.length ? b : a));
  if (best.rawText.length < 50) return { candidates: [] };

  console.log(`[lookup] Roman fallback: ${best.source} (${best.rawText.length}c)`);
  return {
    candidates: [{
      title:      best.title  || title,
      artist:     best.artist || artist || '',
      devanagari: stripResidualHtml(best.rawText),
      confidence: 'medium',
      notes:      `Roman via ${best.source}.com`,
    }],
  };
}
