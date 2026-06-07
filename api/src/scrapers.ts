/**
 * Lyric site scrapers. Each function searches a site for a song and returns
 * the cleanest available lyric text, or null if the site has no match.
 *
 * HTML parsing uses Cloudflare Workers' built-in HTMLRewriter instead of regex
 * so nested elements, quoted attributes with >, etc. can't corrupt the output.
 */

export interface RawLyricResult {
  source: 'lyricsdex' | 'lyricsraag' | 'genius' | 'youtube' | 'lyricalsansar';
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
  // Use only the primary artist (first comma-separated value) to avoid over-constraining search
  const primaryArtist = artist?.split(',')[0].trim();
  return encodeURIComponent(primaryArtist ? `${title} ${primaryArtist}` : title);
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
    const artistList = artist
      ? artist.split(/,/).map((a) => a.trim()).filter(Boolean)
      : [undefined as string | undefined];

    // Prefer heading-based links (song pages); collect translation fallback separately
    let pageUrl: string | null = null;
    let translationFallback: string | null = null;
    for (const a of artistList) {
      const res = await fetchWithTimeout(`https://lyricsraag.com/?s=${buildQuery(title, a)}`);
      if (!res.ok) continue;
      const html = await res.text();
      // LyricsRaag search results use vista-post-card__link (card layout, not entry-title)
      const cardRe = /href="(https?:\/\/lyricsraag\.com\/(?!wp-content|language\/|feed)[^"]+)"[^>]*class="[^"]*vista-post-card__link/g;
      const cardLinks: string[] = [];
      for (const m of html.matchAll(cardRe)) cardLinks.push(m[1]);
      const nonTranslation = cardLinks.find(u => !u.includes('-translation'));
      if (nonTranslation) { pageUrl = nonTranslation; break; }
      if (!translationFallback) {
        translationFallback = cardLinks.find(u => u.includes('-translation')) ?? null;
      }
    }
    pageUrl = pageUrl ?? translationFallback;
    if (!pageUrl) { console.warn('[lyricsraag] no result link'); return null; }

    // Slug check before fetching — reject pages where title words don't appear in the URL slug
    const urlSlug = new URL(pageUrl).pathname.replace(/-lyrics\/?$/, '').split('/').filter(Boolean).pop() ?? '';
    const slugNorm = urlSlug.replace(/-/g, ' ');
    if (slugNorm && !titleMatches(title, slugNorm)) {
      console.warn(`[lyricsraag] slug mismatch early exit: "${title}" vs "${slugNorm}"`);
      return null;
    }

    const pageRes = await fetchWithTimeout(pageUrl);
    if (!pageRes.ok) { console.warn(`[lyricsraag] page ${pageRes.status}`); return null; }
    const pageHtml = await pageRes.text();

    // Try JSON-LD first; fall back to entry-content div
    const ld = extractJsonLdMusicRecording(pageHtml);
    let rawText = ld?.recordingOf?.lyrics?.text ?? ld?.lyrics?.text ?? '';
    if (!rawText || rawText.length < 50) {
      // Fall back: extract <p align="left"> paragraphs from entry-content (lyric paragraphs on LyricsRaag)
      const lyricParas = (pageHtml.match(/<p[^>]*align="left"[^>]*>([\s\S]*?)<\/p>/gi) ?? [])
        .map((p) => htmlToText(p).trim())
        // prose descriptions have no newlines and are long; lyric stanzas always have \n
        .filter((t) => t.length > 0 && t.length < 400 && (t.includes('\n') || t.length < 80));
      rawText = lyricParas.join('\n\n');
    }
    if (!rawText || rawText.length < 50) { console.warn('[lyricsraag] no lyrics found'); return null; }

    const cleanText = htmlToText(rawText).replace(/\r\n/g, '\n').trim();
    const detected = detectScript(cleanText);

    const ldName = ld?.name ?? ld?.recordingOf?.name;
    const songTitle = ldName ?? (() => {
      // No JSON-LD name — extract from HTML <title> tag
      // LyricsRaag format: "Tum Bin Lyrics – Sanam Re | Shreya Ghoshal | LyricsRaag"
      const raw = pageHtml.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? '';
      return raw.replace(/\s+lyrics\b.*/i, '').replace(/\s*[-–|].*/, '').trim();
    })();
    // Empty songTitle means we can't verify — safer to reject than return wrong lyrics
    if (!songTitle || !titleMatches(title, songTitle)) {
      console.warn(`[lyricsraag] title mismatch: "${title}" vs "${songTitle || '(empty)'}"`);
      return null;
    }

    const byArtist = ld?.byArtist;
    let artistName = Array.isArray(byArtist)
      ? byArtist.map(x => x.name).filter(Boolean).join(', ')
      : byArtist?.name ?? '';
    if (!artistName) {
      const pageTitleMatch = pageHtml.match(/<title>([^<]+)<\/title>/i);
      const artistFromTitle = pageTitleMatch?.[1]?.match(/[-–]\s*([^|<\n]+)/)?.[1]?.trim();
      artistName = artistFromTitle || artist || '';
    }

    return {
      source: 'lyricsraag',
      url: pageUrl,
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

// ── YouTube ───────────────────────────────────────────────────────────────────

interface YTSearchItem {
  id: { videoId: string };
  snippet: { title: string; channelTitle: string };
}

interface YTVideoItem {
  id: string;
  snippet: { title: string; channelTitle: string; description: string };
}

async function aiExtractLyrics(desc: string, openaiKey: string, model: string): Promise<string> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Extract only the song lyrics from this YouTube video description. ' +
              'Return just the lyrics preserving original line breaks and script (Devanagari, Arabic, Roman, etc.). ' +
              'Exclude all credits, links, timestamps, hashtags, equipment lists, and metadata. ' +
              'If no lyrics are present, return an empty string.',
          },
          { role: 'user', content: desc },
        ],
        max_completion_tokens: 1200,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[youtube/ai] OpenAI error ${res.status}: ${errText.slice(0, 200)}`);
      return '';
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const extracted = data.choices?.[0]?.message?.content?.trim() ?? '';
    console.log(`[youtube/ai] extracted ${extracted.length}c`);
    return extracted;
  } catch (err) {
    console.warn('[youtube/ai] error:', err instanceof Error ? err.message : err);
    return '';
  }
}

export async function searchYouTube(
  title: string,
  artist: string | undefined,
  youtubeKey: string,
  openaiKey: string,
  model: string
): Promise<RawLyricResult | null> {
  try {
    const q = encodeURIComponent(`${title}${artist ? ' ' + artist : ''} lyrics`);

    // Step 1: search for videos (100 quota units)
    const searchRes = await fetchWithTimeout(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&maxResults=6&key=${youtubeKey}`,
      5000
    );
    if (!searchRes.ok) { console.warn(`[youtube] search ${searchRes.status}`); return null; }
    const searchData = (await searchRes.json()) as { items?: YTSearchItem[] };
    const items = searchData.items ?? [];
    if (items.length === 0) { console.warn('[youtube] no search results'); return null; }

    // Step 2: fetch all descriptions in one call (1 quota unit per video)
    const ids = items.map(i => i.id.videoId).join(',');
    const vidRes = await fetchWithTimeout(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${ids}&key=${youtubeKey}`,
      5000
    );
    if (!vidRes.ok) { console.warn(`[youtube] videos ${vidRes.status}`); return null; }
    const vidData = (await vidRes.json()) as { items?: YTVideoItem[] };
    const allVideos = vidData.items ?? [];
    const candidates = allVideos.filter(v =>
      v.snippet.description.length >= 80 && titleMatches(title, v.snippet.title)
    );
    console.log(`[youtube] ${allVideos.length} videos fetched, ${candidates.length} passed title+desc filter`);
    if (candidates.length === 0) { console.warn('[youtube] no matching videos'); return null; }

    // Step 3: AI extracts lyrics from each description; pick best result
    const extracted = await Promise.all(
      candidates.slice(0, 4).map(async video => {
        const lyrics = await aiExtractLyrics(video.snippet.description, openaiKey, model);
        return { video, lyrics };
      })
    );

    let bestNative: { video: YTVideoItem; text: string; script: RawLyricResult['detectedScript'] } | null = null;
    let bestRoman:  { video: YTVideoItem; text: string } | null = null;

    for (const { video, lyrics } of extracted) {
      if (lyrics.length < 60) continue;
      const detected = detectScript(lyrics);
      if (detected && (!bestNative || lyrics.length > bestNative.text.length)) {
        bestNative = { video, text: lyrics, script: detected };
      } else if (!detected && (!bestRoman || lyrics.length > bestRoman.text.length)) {
        bestRoman = { video, text: lyrics };
      }
    }

    const winner = bestNative ?? bestRoman;
    if (!winner) { console.warn('[youtube] no lyrics extracted'); return null; }

    const detected = bestNative?.script;
    console.log(`[youtube] ✓ ${winner.video.snippet.title} (${detected ?? 'roman'}, ${winner.text.length}c)`);

    return {
      source: 'youtube',
      url: `https://www.youtube.com/watch?v=${winner.video.id}`,
      title: winner.video.snippet.title,
      artist: winner.video.snippet.channelTitle,
      rawText: winner.text,
      scriptHint: detected ? 'native' : 'roman',
      detectedScript: detected,
    };
  } catch (err) {
    console.warn('[youtube] error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── LyricalSansar ─────────────────────────────────────────────────────────────

export async function searchLyricalSansar(
  title: string,
  artist: string | undefined
): Promise<RawLyricResult | null> {
  try {
    // WordPress REST API search — much more reliable than scraping search results HTML
    const searchRes = await fetchWithTimeout(
      `https://lyricalsansar.com/wp-json/wp/v2/posts?search=${encodeURIComponent(title)}&per_page=20&_fields=title,link`
    );
    if (!searchRes.ok) { console.warn(`[lyricalsansar] search ${searchRes.status}`); return null; }
    const posts = (await searchRes.json()) as { title: { rendered: string }; link: string }[];

    let pageUrl: string | null = null;
    let foundArtist = '';
    for (const post of posts) {
      // Post title format: "Khoya Lyrics – Akshath Acharya & Rovalio"
      const decoded = htmlToText(post.title.rendered);
      const songPart = decoded.replace(/\s+lyrics\b.*/i, '').trim();
      if (!titleMatches(title, songPart)) continue;

      const artistPart = decoded.replace(/^.*\blyrics\b\s*[-–]\s*/i, '').trim();
      if (artist && artistPart && !artistOverlap(artist, artistPart)) continue;

      pageUrl = post.link;
      foundArtist = artistPart;
      break;
    }

    if (!pageUrl) { console.warn('[lyricalsansar] no matching post'); return null; }

    const pageRes = await fetchWithTimeout(pageUrl);
    if (!pageRes.ok) { console.warn(`[lyricalsansar] page ${pageRes.status}`); return null; }
    const pageHtml = await pageRes.text();

    // Lyric stanzas are <p> tags containing <br> tags; stop at the "End The Lyrics" marker
    const stanzas: string[] = [];
    for (const [, inner] of pageHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      if (/end\s+the\s+lyrics/i.test(inner)) break;
      if (!inner.includes('<br')) continue;
      const text = htmlToText(inner).trim();
      if (text.length >= 10) stanzas.push(text);
    }

    if (stanzas.length === 0) { console.warn('[lyricalsansar] no lyrics found'); return null; }
    const rawText = stanzas.join('\n\n');
    const detected = detectScript(rawText);

    console.log(`[lyricalsansar] ✓ "${title}" (${detected ?? 'roman'}, ${rawText.length}c)`);
    return {
      source: 'lyricalsansar',
      url: pageUrl,
      title,
      artist: foundArtist || artist || '',
      rawText,
      scriptHint: detected ? 'native' : 'roman',
      detectedScript: detected,
    };
  } catch (err) {
    console.warn('[lyricalsansar] error:', err instanceof Error ? err.message : err);
    return null;
  }
}
