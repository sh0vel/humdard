/**
 * Lyric site scrapers. Each function searches a site for a song and returns
 * the cleanest available lyric text, or null if the site has no match.
 *
 * HTML parsing uses Cloudflare Workers' built-in HTMLRewriter instead of regex
 * so nested elements, quoted attributes with >, etc. can't corrupt the output.
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

export function detectScript(text: string): RawLyricResult['detectedScript'] | undefined {
  const nonWhitespace = text.replace(/\s+/g, '').length;
  if (nonWhitespace < 20) return undefined;
  let bestName: RawLyricResult['detectedScript'] | undefined;
  let bestCount = 0;
  for (const [name, re] of Object.entries(SCRIPTS)) {
    const count = (text.match(re) ?? []).length;
    if (count > bestCount) { bestCount = count; bestName = name as RawLyricResult['detectedScript']; }
  }
  return bestCount / nonWhitespace >= 0.3 ? bestName : undefined;
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

// ── HTMLRewriter helpers ──────────────────────────────────────────────────────

/**
 * Extract plain text from all elements matching `selector` inside `html`.
 * `brSelector` (optional) is a selector for <br>-like elements that become \n.
 * Returns one string per matched root element.
 */
async function extractTextBlocks(
  html: string,
  selector: string,
  brSelector?: string
): Promise<string[]> {
  const blocks: string[][] = [];

  let rw = new HTMLRewriter().on(selector, {
    element() { blocks.push([]); },
    text(chunk) { if (chunk.text) blocks[blocks.length - 1]?.push(chunk.text); },
  });

  if (brSelector) {
    rw = rw.on(brSelector, {
      element() { blocks[blocks.length - 1]?.push('\n'); },
    });
  }

  await rw.transform(new Response(html)).arrayBuffer();

  return blocks
    .map(b => b.join('').replace(/\n{3,}/g, '\n\n').trim())
    .filter(b => b.length >= 30);
}

/** Remove elements matching `selector` from HTML, return cleaned HTML string. */
async function removeElements(html: string, selector: string): Promise<string> {
  return new HTMLRewriter()
    .on(selector, { element(el) { el.remove(); } })
    .transform(new Response(html))
    .text();
}

/** Extract text content of the first element matching `selector`. */
async function extractFirstText(html: string, selector: string): Promise<string> {
  const chunks: string[] = [];
  let found = false;
  await new HTMLRewriter()
    .on(selector, {
      element() { if (!found) { found = true; chunks.length = 0; } },
      text(chunk) { if (found && chunk.text) chunks.push(chunk.text); },
    })
    .transform(new Response(html))
    .arrayBuffer();
  return chunks.join('').trim();
}

// ── Shared utilities ──────────────────────────────────────────────────────────

function buildQuery(title: string, artist?: string): string {
  return encodeURIComponent(artist ? `${title} ${artist}` : title);
}

function titleMatches(query: string, found: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = (s: string) => normalize(s).split(/\s+/).filter((w) => w.length >= 2);
  const qw = words(query);
  if (qw.length === 0) return false;
  return qw.every((w) => normalize(found).includes(w));
}

function artistOverlap(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const words = (s: string) => normalize(s).split(/\s+/).filter((w) => w.length >= 2);
  const aw = words(a);
  const bw = words(b);
  return aw.some((w) => bw.some((bk) => bk.includes(w) || w.includes(bk)));
}

/**
 * Fallback HTML-to-text for cases where we only have a raw HTML string (e.g.
 * JSON-LD `text` fields that sometimes contain inline tags). Uses a regex that
 * handles partial/unclosed tags so stray `</div` can't leak through.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|td)[^>]*>/gi, '\n')
    // Handles full tags AND partial/unclosed tags like `</div` with no `>`
    .replace(/<\/?[a-zA-Z][^>]*>?/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── LyricsDex ────────────────────────────────────────────────────────────────

export async function searchLyricsDex(
  title: string,
  artist: string | undefined
): Promise<RawLyricResult | null> {
  try {
    const searchRes = await fetchWithTimeout(
      `https://www.lyricsdex.com/?s=${buildQuery(title, artist)}`
    );
    if (!searchRes.ok) { console.warn(`[lyricsdex] search ${searchRes.status}`); return null; }
    const searchHtml = await searchRes.text();

    const linkMatch = searchHtml.match(
      /<article[^>]*class="[^"]*search-result-item[^"]*"[\s\S]*?<a[^>]+href="([^"]+)"/
    );
    if (!linkMatch) { console.warn('[lyricsdex] no result article'); return null; }

    const pageUrl = linkMatch[1].startsWith('http')
      ? linkMatch[1]
      : `https://www.lyricsdex.com${linkMatch[1]}`;

    const pageRes = await fetchWithTimeout(pageUrl);
    if (!pageRes.ok) { console.warn(`[lyricsdex] page ${pageRes.status}`); return null; }
    const pageHtml = await pageRes.text();

    // HTMLRewriter extracts each .lyrics-text block as clean text
    const rawBlocks = await extractTextBlocks(pageHtml, 'div.lyrics-text', 'div.lyrics-text br');
    if (rawBlocks.length === 0) { console.warn('[lyricsdex] no lyrics-text blocks'); return null; }

    const blocks = rawBlocks.map(rawText => ({ rawText, script: detectScript(rawText) }));

    const preference = ['devanagari', 'nastaliq', 'gurmukhi', 'bengali'] as const;
    const chosen = blocks.find(b => b.script && preference.includes(b.script as never)) ?? blocks[0];

    // Page title via HTMLRewriter
    const rawTitle = await extractFirstText(pageHtml, 'h1');
    const cleanTitle = rawTitle.replace(/\s+Lyrics.*$/i, '').trim() || title;

    if (!titleMatches(title, cleanTitle)) {
      console.warn(`[lyricsdex] title mismatch: "${title}" vs "${cleanTitle}"`);
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

// ── LyricsRaag ───────────────────────────────────────────────────────────────

interface MusicRecordingLD {
  '@type'?: string;
  name?: string;
  byArtist?: { name?: string }[] | { name?: string };
  lyrics?: { text?: string };
  recordingOf?: { name?: string; lyrics?: { text?: string }; lyricist?: { name?: string }[] };
}

function extractJsonLdMusicRecording(html: string): MusicRecordingLD | null {
  const scriptRe = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of items) {
        if (c && (c['@type'] === 'MusicRecording' || c.recordingOf || c.lyrics)) return c;
      }
    } catch { /* skip malformed blocks */ }
  }
  return null;
}

export async function searchLyricsRaag(
  title: string,
  artist: string | undefined
): Promise<RawLyricResult | null> {
  try {
    const searchRes = await fetchWithTimeout(
      `https://lyricsraag.com/?s=${buildQuery(title, artist)}`
    );
    if (!searchRes.ok) { console.warn(`[lyricsraag] search ${searchRes.status}`); return null; }
    const searchHtml = await searchRes.text();

    const linkMatch =
      searchHtml.match(/<h2[^>]*class="[^"]*entry-title[^"]*"[\s\S]*?<a[^>]+href="([^"]+)"/) ||
      searchHtml.match(/<a[^>]+href="(https:\/\/lyricsraag\.com\/[^"]*-translation[^"]*)"[^>]*>/i);
    if (!linkMatch) { console.warn('[lyricsraag] no result link'); return null; }

    const pageRes = await fetchWithTimeout(linkMatch[1]);
    if (!pageRes.ok) { console.warn(`[lyricsraag] page ${pageRes.status}`); return null; }
    const pageHtml = await pageRes.text();

    const ld = extractJsonLdMusicRecording(pageHtml);
    const rawText = ld?.recordingOf?.lyrics?.text ?? ld?.lyrics?.text ?? '';
    if (!rawText || rawText.length < 50) { console.warn('[lyricsraag] no JSON-LD lyrics'); return null; }

    // JSON-LD text can contain inline HTML — pass through htmlToText to clean
    const cleanText = htmlToText(rawText).replace(/\r\n/g, '\n').trim();
    const detected = detectScript(cleanText);

    const songTitle = ld?.name ?? ld?.recordingOf?.name ?? title;
    if (!titleMatches(title, songTitle ?? '')) {
      console.warn(`[lyricsraag] title mismatch: "${title}" vs "${songTitle}"`);
      return null;
    }

    const byArtist = ld?.byArtist;
    const artistName = Array.isArray(byArtist)
      ? byArtist.map(x => x.name).filter(Boolean).join(', ')
      : byArtist?.name ?? artist ?? '';

    return {
      source: 'lyricsraag',
      url: linkMatch[1],
      title: (songTitle ?? title).trim(),
      artist: artistName,
      rawText: cleanText,
      scriptHint: detected ? 'native' : 'roman',
      detectedScript: detected,
    };
  } catch (err) {
    console.warn('[lyricsraag] error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Genius ───────────────────────────────────────────────────────────────────

interface GeniusSearchHit {
  result: { url: string; title: string; primary_artist?: { name?: string } };
}

export async function searchGenius(
  title: string,
  artist: string | undefined
): Promise<RawLyricResult | null> {
  try {
    const query = buildQuery(title, artist);
    const searchRes = await fetchWithTimeout(
      `https://genius.com/api/search/multi?per_page=3&q=${query}`
    );
    if (!searchRes.ok) { console.warn(`[genius] search ${searchRes.status}`); return null; }
    const searchData = (await searchRes.json()) as {
      response?: { sections?: { hits?: GeniusSearchHit[] }[] };
    };

    const primaryHits = searchData.response?.sections?.[0]?.hits ?? [];
    let extraHits: GeniusSearchHit[] = [];
    if (artist) {
      const fb = await fetchWithTimeout(
        `https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(title)}`
      );
      if (fb.ok) {
        const d = (await fb.json()) as typeof searchData;
        extraHits = d.response?.sections?.[0]?.hits ?? [];
      }
    }

    const seen = new Set<string>();
    const artistMatch: GeniusSearchHit[] = [];
    const noArtistMatch: GeniusSearchHit[] = [];
    for (const h of [...primaryHits, ...extraHits]) {
      if (!h.result?.url || !h.result?.title || seen.has(h.result.url)) continue;
      if (!titleMatches(title, h.result.title)) continue;
      seen.add(h.result.url);
      const t = h.result.title.toLowerCase();
      if (t.includes('romanized') || t.includes('translation')) continue;
      const foundArtist = h.result.primary_artist?.name ?? '';
      if (artist && foundArtist && !artistOverlap(artist, foundArtist)) {
        noArtistMatch.push(h);
      } else {
        artistMatch.push(h);
      }
    }
    const candidates = [...artistMatch, ...noArtistMatch];

    if (candidates.length === 0) { console.warn('[genius] no matching result'); return null; }

    for (const hit of candidates) {
      const pageRes = await fetchWithTimeout(hit.result.url);
      if (!pageRes.ok) continue;
      const html = await pageRes.text();
      if (!html.includes('data-lyrics-container')) continue;

      // Step 1: strip ad/annotation divs
      const cleaned = await removeElements(html, '[data-exclude-from-selection="true"]');

      // Step 2: extract lyrics containers with HTMLRewriter
      const blocks = await extractTextBlocks(
        cleaned,
        '[data-lyrics-container="true"]',
        '[data-lyrics-container="true"] br'
      );

      const rawText = blocks
        .map(b => b.replace(/\[.*?\]/g, '').replace(/\n*You might also like[\s\S]*/i, '').trim())
        .filter(b => b.length > 5)
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (!rawText || rawText.length < 50) {
        console.warn(`[genius] no lyrics on ${hit.result.url}`);
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

    console.warn('[genius] no lyrics from any candidate');
    return null;
  } catch (err) {
    console.warn('[genius] error:', err instanceof Error ? err.message : err);
    return null;
  }
}
