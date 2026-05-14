/**
 * Prompts for Stage 2 of the lookup pipeline:
 * normalize scraped text via Chat Completions.
 */

import { RawLyricResult } from './scrapers';

export const LOOKUP_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          artist: { type: 'string' },
          devanagari: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          notes: { type: 'string' },
        },
        required: ['title', 'artist', 'devanagari', 'confidence', 'notes'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
};

export function stage2SystemPrompt(): string {
  return `You are normalizing 1-2 raw lyric text excerpts scraped from lyric sites.
Your job: clean them up, transliterate to the correct native script if needed, and return one or more LookupCandidate objects. DO NOT invent or expand lyrics.

LANGUAGE → SCRIPT MAPPING
- Hindi → Devanagari (e.g. चल दिए तुम कहाँ)
- Urdu → Nastaliq / Perso-Arabic (e.g. چل دیے تم کہاں)
- Punjabi → Gurmukhi (e.g. ਚਲ ਦਿੱਤੇ ਤੁਸੀਂ ਕਿੱਥੇ)
- Bangla → Bengali script

IMPORTANT BIAS: For ambiguous Hindustani songs (Bollywood that could be classified either Hindi or Urdu), DEFAULT TO DEVANAGARI. The downstream lesson generator is Hindi-tuned. Only return Nastaliq when the song is clearly Urdu-only (Pakistani artist working in Urdu tradition, ghazal form, no Devanagari version available).

PER-EXCERPT RULES
1. If an excerpt's detectedScript already matches the target script, keep the text as-is. Preserve original line breaks.
2. If an excerpt is Roman (no detectedScript), transliterate to the native script. Preserve line breaks. Common Bollywood/desi spelling conventions:
   - "kyun" → क्यों, "zindagi" → ज़िंदगी, "nahin" → नहीं, "yahaan" → यहाँ
   - Translate IDEAS faithfully but do NOT paraphrase or add poetic flourishes.

MERGING vs MULTIPLE CANDIDATES
- If both excerpts describe THE SAME SONG, merge into ONE candidate. Prefer the native-script source when merging.
- If the excerpts clearly describe DIFFERENT songs (one scraper matched the wrong title), return them as SEPARATE candidates (up to 3 total).

CONFIDENCE
- "high"   = ≥1 excerpt was already in the target native script (clean direct copy)
- "medium" = had to transliterate from Roman with confident judgment
- "low"    = source text was noisy, ambiguous, or sparse

NOTES (short attribution, max 80 chars)
- "via lyricsdex.com (Devanagari)"
- "transliterated from lyricsraag.com (Roman)"
- "merged from lyricsdex.com + lyricsread.com"

NEVER invent lyrics. If excerpts are unusable (gibberish, clearly wrong song, etc.), return { "candidates": [] } — the caller will fall back to web search.

Return ONLY JSON matching the schema.`;
}

export function stage2UserPrompt(
  title: string,
  artist: string | undefined,
  excerpts: RawLyricResult[]
): string {
  let prompt = `Song request:\nTitle: ${title}\n`;
  if (artist) prompt += `Artist: ${artist}\n`;
  prompt += `\nScraped excerpts (${excerpts.length}):\n\n`;

  excerpts.forEach((e, i) => {
    prompt += `--- Excerpt ${i + 1} ---\n`;
    prompt += `source: ${e.source}\n`;
    prompt += `url: ${e.url}\n`;
    prompt += `scriptHint: ${e.scriptHint}`;
    if (e.detectedScript) prompt += ` (${e.detectedScript})`;
    prompt += `\nrawText:\n${e.rawText}\n\n`;
  });

  prompt += `Normalize per the rules. Return JSON.`;
  return prompt;
}

