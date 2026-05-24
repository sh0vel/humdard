/**
 * Lyric site scrapers. Each function searches a site for a song and returns
 * the cleanest available lyric text, or null if the site has no match.
 *
 * Verified against "Har Baar" by Murtaza Qizilbash (Urdu, 2025).
 */

export interface RawLyricResult {
  source: 'lyricsdex' | 'lyricsraag' | 'genius';
  url: string;
  title: string;
  artist: string;
  rawText: string;
  scriptHint: 'native' | 'roman';
  detectedScript?: 'devanagari' | 'nastaliq' | 'gurmukhi' | 'bengali';
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

const SCRIPTS: Record<NonNullable<RawLyricResult['detectedScript']>, RegExp> = {
  devanagari: /[ऀ-ॿ]/g,
  nastaliq: /[؀-ۿݐ-ݿ]/g,
  gurmukhi: /[਀-੿]/g,
  bengali: /[ঀ-৿]/g,
};

/**
 * Returns the dominant native script in `text` if it constitutes ≥ 30% of the
 * non-whitespace characters, otherwise returns undefined.
 *
 * Single-character noise (e.g. one Devanagari char in a sea of Roman) does NOT
 * count as "native script" — we need the text to actually be in that script.
 */
export function detectScript(text: string): RawLyricResult['detectedScript'] | undefined {
  const nonWhitespace = text.replace(/\s+/g, '').length;
  if (nonWhitespace < 20) return undefined;

  let bestName: RawLyricResult['detectedScript'] | undefined;
  let bestCount = 0;
  for (const [name, re] of Object.entries(SCRIPTS)) {
    const matches = text.match(re);
    const count = matches ? matches.length : 0;
    if (count > bestCount) {
      bestCount = count;
      bestName = name as RawLyricResult['detectedScript'];
    }
  }
  // Require at least 30% of non-whitespace chars to be in the dominant script
  if (bestCount / nonWhitespace >= 0.3) return bestName;
  return undefined;
}

async function fetchWithTimeout(url: string, ms = 4000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: BROWSER_HEADERS, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(p|div|li|tr|td)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildQuery(title: string, artist?: string): string {
  return encodeURIComponent(artist ? `${title} ${artist}` : title);
}

// Returns true if every word in `query` (length >= 2) appears in `found`.
// We have the exact song title from the user so we require all words to match,
// not just one — this prevents "Ya Tum" matching a search for "Tum Hi Ho".
function titleMatches(query: string, found: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = (s: string) => normalize(s).split(/\s+/).filter((w) => w.length >= 2);
  const qw = words(query);
  if (qw.length === 0) return false;
  const foundNorm = normalize(found);
  return qw.every((w) => foundNorm.includes(w));
}

// ============================================================================
// LyricsDex
// ============================================================================

export async function searchLyricsDex(
  title: string,
  artist: string | undefined
): Promise<RawLyricResult | null> {
  try {
    const searchUrl = `https://www.lyricsdex.com/?s=${buildQuery(title, artist)}`;
    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) {
      console.warn(`[lyricsdex] search ${searchRes.status}`);
      return null;
    }
    const searchHtml = await searchRes.text();

    // Search results live inside <article class="search-result-item">.
    // The first <a href="..."> inside that article is the song page link.
    const linkMatch = searchHtml.match(
      /<article[^>]*class="[^"]*search-result-item[^"]*"[\s\S]*?<a[^>]+href="([^"]+)"/
    );
    if (!linkMatch) {
      console.warn('[lyricsdex] no search-result-item article');
      return null;
    }
    const pageUrl = linkMatch[1].startsWith('http')
      ? linkMatch[1]
      : `https://www.lyricsdex.com${linkMatch[1]}`;

    const pageRes = await fetchWithTimeout(pageUrl);
    if (!pageRes.ok) {
      console.warn(`[lyricsdex] page ${pageRes.status} for ${pageUrl}`);
      return null;
    }
    const pageHtml = await pageRes.text();

    // Multiple <div class="lyrics-text ..."> blocks: Roman, Devanagari,
    // Nastaliq, English. Prefer Devanagari, then Nastaliq, Gurmukhi, Bengali,
    // then Roman.
    const blocks: { rawText: string; script?: RawLyricResult['detectedScript'] }[] = [];
    const blockRe = /<div[^>]*class="lyrics-text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(pageHtml)) !== null) {
      const text = htmlToText(m[1]);
      if (!text || text.length < 30) continue;
      blocks.push({ rawText: text, script: detectScript(text) });
    }
    if (blocks.length === 0) {
      console.warn('[lyricsdex] no lyrics-text blocks on page');
      return null;
    }

    const preference = ['devanagari', 'nastaliq', 'gurmukhi', 'bengali'] as const;
    let chosen = blocks.find((b) => b.script && preference.includes(b.script as never));
    if (!chosen) chosen = blocks[0];

    const titleFromPage =
      pageHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replace(/<[^>]+>/g, '').trim() || title;
    const cleanTitle = decodeEntities(titleFromPage).replace(/\s+Lyrics.*$/i, '').trim();

    if (!titleMatches(title, cleanTitle)) {
      console.warn(`[lyricsdex] title mismatch: searched "${title}", got "${cleanTitle}"`);
      return null;
    }

    return {
      source: 'lyricsdex',
      url: pageUrl,
      title: cleanTitle,
      artist: artist ?? '',
      rawText: chosen.rawText,
      scriptHint: chosen.script ? 'native' : 'roman',
      detectedScript: chosen.script,
    };
  } catch (err) {
    console.warn('[lyricsdex] error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ============================================================================
// LyricsRaag (parses JSON-LD schema.org MusicRecording instead of HTML)
// ============================================================================

interface MusicRecordingLD {
  '@type'?: string;
  name?: string;
  byArtist?: { name?: string }[] | { name?: string };
  inLanguage?: string;
  lyrics?: { text?: string };
  recordingOf?: {
    name?: string;
    lyrics?: { text?: string };
    lyricist?: { name?: string }[];
  };
}

function extractJsonLdMusicRecording(html: string): MusicRecordingLD | null {
  const scriptRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        if (c && (c['@type'] === 'MusicRecording' || c.recordingOf || c.lyrics)) {
          return c as MusicRecordingLD;
        }
      }
    } catch {
      // Some JSON-LD blocks have stray characters; skip and try the next.
    }
  }
  return null;
}

export async function searchLyricsRaag(
  title: string,
  artist: string | undefined
): Promise<RawLyricResult | null> {
  try {
    const searchUrl = `https://lyricsraag.com/?s=${buildQuery(title, artist)}`;
    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) {
      console.warn(`[lyricsraag] search ${searchRes.status}`);
      return null;
    }
    const searchHtml = await searchRes.text();

    const linkMatch =
      searchHtml.match(/<h2[^>]*class="[^"]*entry-title[^"]*"[\s\S]*?<a[^>]+href="([^"]+)"/) ||
      searchHtml.match(/<a[^>]+href="(https:\/\/lyricsraag\.com\/[^"]*-translation[^"]*)"[^>]*>/i);
    if (!linkMatch) {
      console.warn('[lyricsraag] no search result link');
      return null;
    }
    const pageUrl = linkMatch[1];

    const pageRes = await fetchWithTimeout(pageUrl);
    if (!pageRes.ok) {
      console.warn(`[lyricsraag] page ${pageRes.status}`);
      return null;
    }
    const pageHtml = await pageRes.text();

    const ld = extractJsonLdMusicRecording(pageHtml);
    const rawText =
      ld?.recordingOf?.lyrics?.text || ld?.lyrics?.text || '';
    if (!rawText || rawText.length < 50) {
      console.warn('[lyricsraag] no JSON-LD lyrics text');
      return null;
    }

    const detected = detectScript(rawText);
    const songTitle = ld?.name || ld?.recordingOf?.name || title;
    const artistName = (() => {
      const a = ld?.byArtist;
      if (Array.isArray(a)) return a.map((x) => x.name).filter(Boolean).join(', ');
      if (a && a.name) return a.name;
      return artist ?? '';
    })();

    if (!titleMatches(title, songTitle ?? '')) {
      console.warn(`[lyricsraag] title mismatch: searched "${title}", got "${songTitle}"`);
      return null;
    }

    return {
      source: 'lyricsraag',
      url: pageUrl,
      title: (songTitle ?? title).trim(),
      artist: artistName,
      rawText: rawText.replace(/\r\n/g, '\n').trim(),
      scriptHint: detected ? 'native' : 'roman',
      detectedScript: detected,
    };
  } catch (err) {
    console.warn('[lyricsraag] error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ============================================================================
// Genius
// ============================================================================

/**
 * Removes all <div> elements that have `attr` anywhere in their opening tag,
 * using div-depth tracking so nested divs are fully consumed.
 */
function removeDivsByAttr(html: string, attr: string): string {
  let result = '';
  let pos = 0;
  while (pos < html.length) {
    const attrIdx = html.indexOf(attr, pos);
    if (attrIdx === -1) { result += html.slice(pos); break; }
    const divStart = html.lastIndexOf('<div', attrIdx);
    if (divStart === -1 || divStart < pos) { result += html.slice(pos); break; }
    result += html.slice(pos, divStart);
    const tagEnd = html.indexOf('>', attrIdx);
    if (tagEnd === -1) break;
    let depth = 1;
    let i = tagEnd + 1;
    while (i < html.length && depth > 0) {
      if (html[i] !== '<') { i++; continue; }
      if (html.startsWith('</div', i)) { depth--; i += 5; }
      else if (html.startsWith('<div', i) && /[\s>]/.test(html[i + 4] ?? '')) { depth++; i += 4; }
      else i++;
    }
    pos = i;
  }
  return result;
}

/**
 * Extracts full lyric text from a Genius HTML page by depth-tracking each
 * data-lyrics-container div. Handles ad divs injected between containers
 * (the old regex approach broke when those appeared).
 */
function extractGeniusLyrics(html: string): string {
  const blocks: string[] = [];
  let pos = 0;
  while (true) {
    const markerIdx = html.indexOf('data-lyrics-container="true"', pos);
    if (markerIdx === -1) break;
    const tagEnd = html.indexOf('>', markerIdx);
    if (tagEnd === -1) break;
    // Depth-track to capture full container content
    let depth = 1;
    let i = tagEnd + 1;
    while (i < html.length && depth > 0) {
      if (html[i] !== '<') { i++; continue; }
      if (html.startsWith('</div', i)) { depth--; i += 5; }
      else if (html.startsWith('<div', i) && /[\s>]/.test(html[i + 4] ?? '')) { depth++; i += 4; }
      else i++;
    }
    const inner = html.slice(tagEnd + 1, i);
    const cleaned = removeDivsByAttr(inner, 'data-exclude-from-selection="true"');
    const text = htmlToText(cleaned)
      .replace(/\[.*?\]/g, '')
      .replace(/\n*You might also like[\s\S]*/i, '')
      .trim();
    if (text.length > 5) blocks.push(text);
    pos = i;
  }
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

interface GeniusSearchHit {
  result: { url: string; title: string; primary_artist?: { name?: string } };
}

export async function searchGenius(
  title: string,
  artist: string | undefined
): Promise<RawLyricResult | null> {
  try {
    const query = buildQuery(title, artist);
    const searchUrl = `https://genius.com/api/search/multi?per_page=3&q=${query}`;
    const searchRes = await fetchWithTimeout(searchUrl);
    if (!searchRes.ok) {
      console.warn(`[genius] search ${searchRes.status}`);
      return null;
    }
    const searchData = (await searchRes.json()) as {
      response?: { sections?: { hits?: GeniusSearchHit[] }[] };
    };

    // Collect hits from title+artist search, then also try title-only to surface
    // "Genius Romanizations" pages that don't appear when artist is in the query.
    const primaryHits = searchData.response?.sections?.[0]?.hits ?? [];
    let extraHits: GeniusSearchHit[] = [];
    if (artist) {
      const fallbackRes = await fetchWithTimeout(
        `https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(title)}`
      );
      if (fallbackRes.ok) {
        const fb = (await fallbackRes.json()) as typeof searchData;
        extraHits = fb.response?.sections?.[0]?.hits ?? [];
      }
    }

    // Rank candidates: native-script pages first, romanized last.
    // Dedupe by URL so we don't fetch the same page twice.
    const seen = new Set<string>();
    const candidates: GeniusSearchHit[] = [];
    for (const h of [...primaryHits, ...extraHits]) {
      if (!h.result?.url || !h.result?.title || seen.has(h.result.url)) continue;
      if (!titleMatches(title, h.result.title)) continue;
      seen.add(h.result.url);
      const t = h.result.title.toLowerCase();
      if (!t.includes('romanized') && !t.includes('translation')) {
        candidates.unshift(h); // native-script pages go first
      } else {
        candidates.push(h); // romanized/translation pages go last
      }
    }

    if (candidates.length === 0) {
      console.warn('[genius] no matching search result');
      return null;
    }

    // Try each candidate in order until one yields actual lyrics.
    for (const hit of candidates) {
      const pageRes = await fetchWithTimeout(hit.result.url);
      if (!pageRes.ok) continue;
      const html = await pageRes.text();
      if (!html.includes('data-lyrics-container')) continue;

      const rawText = extractGeniusLyrics(html);

      if (!rawText || rawText.length < 50) {
        console.warn(`[genius] no lyrics on ${hit.result.url}, trying next`);
        continue;
      }

      const detected = detectScript(rawText);
      return {
        source: 'genius',
        url: hit.result.url,
        title: hit.result.title,
        artist: hit.result.primary_artist?.name ?? artist ?? '',
        rawText,
        scriptHint: detected ? 'native' : 'roman',
        detectedScript: detected,
      };
    }

    console.warn('[genius] no lyrics extracted from any candidate');
    return null;
  } catch (err) {
    console.warn('[genius] error:', err instanceof Error ? err.message : err);
    return null;
  }
}
