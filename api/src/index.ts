/**
 * Cloudflare Worker - Lyric Learning API
 * Main entry point with routing and request handlers
 */

import { Env, JsonifyQueuedResponse, JsonifyQueueMessage, SongsListResponse, LyricLesson, LyricLine, JobStatus } from './types';
import { handleCorsPreFlight, addCorsHeaders } from './cors';
import { getSong, putSong, listMetas, putMeta, getMeta, deleteSong, updateLine, deleteLineFromSong, getJob, putJob, insertInstrumentalBefore } from './storage';
import { generateLyricLesson, retranslateLine } from './openai';
import { lookupLyrics } from './lookup';
import { validateJsonifyRequest, validateLyricLesson, ValidationError, normalizeLyrics } from './validate';
import { generateSongId, generateFullHash } from './utils';
import { trackApiRequest, trackGeneration, trackRetranslateLine, trackLookup, normalizeEndpoint, parseLookupSource } from './analytics';

/**
 * Main request handler + queue consumer
 */
export default {
  async queue(batch: MessageBatch<JsonifyQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processGenerationJob(env, message.body);
      message.ack();
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCorsPreFlight(request, env);
    }

    const reqT0 = Date.now();

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Route requests
      let response: Response;

      if (path === '/api/songs' && request.method === 'GET') {
        response = await handleGetSongs(request, env);
      } else if (path.startsWith('/api/songs/') && request.method === 'GET') {
        const songId = path.split('/api/songs/')[1];
        response = await handleGetSong(request, env, songId);
      } else if (/^\/api\/songs\/[^/]+\/lines\/[^/]+$/.test(path) && request.method === 'DELETE') {
        const [, , , songId, , lineId] = path.split('/');
        response = await handleDeleteLine(request, env, songId, lineId);
      } else if (path.startsWith('/api/songs/') && request.method === 'DELETE') {
        const songId = path.split('/api/songs/')[1];
        response = await handleDeleteSong(request, env, songId);
      } else if (/^\/api\/songs\/[^/]+\/lines\/[^/]+$/.test(path) && request.method === 'PATCH') {
        const [, , , songId, , lineId] = path.split('/');
        response = await handleUpdateLine(request, env, songId, lineId);
      } else if (/^\/api\/songs\/[^/]+\/lines\/[^/]+\/retranslate$/.test(path) && request.method === 'POST') {
        const [, , , songId, , lineId] = path.split('/');
        response = await handleRetranslateLine(request, env, songId, lineId);
      } else if (/^\/api\/songs\/[^/]+\/lines\/[^/]+\/instrumental$/.test(path) && request.method === 'POST') {
        const [, , , songId, , lineId] = path.split('/');
        response = await handleInsertInstrumental(request, env, songId, lineId);
      } else if (/^\/api\/songs\/[^/]+\/retranslate$/.test(path) && request.method === 'POST') {
        const songId = path.split('/')[3];
        response = await handleRetranslateSong(request, env, songId);
      } else if (path === '/api/jsonify' && request.method === 'POST') {
        response = await handleJsonify(request, env);
      } else if (path.startsWith('/api/jobs/') && request.method === 'GET') {
        const jobId = path.split('/api/jobs/')[1];
        response = await handleGetJob(request, env, jobId);
      } else if (path === '/api/lookup' && request.method === 'POST') {
        response = await handleLookup(request, env);
      } else if (path === '/api/spotify/search' && request.method === 'GET') {
        response = await handleSpotifySearch(request, env);
      } else if (path === '/api/admin/backfill-images' && request.method === 'POST') {
        response = await handleBackfillImages(env);
      } else if (path === '/api/admin/reset-updated-at' && request.method === 'POST') {
        response = await handleResetUpdatedAt(env);
      } else {
        response = jsonResponse(
          { error: { code: 'NOT_FOUND', message: 'Endpoint not found' } },
          404
        );
      }

      // Add CORS headers to response
      const finalResponse = addCorsHeaders(response, request, env);
      trackApiRequest(env, {
        endpoint: normalizeEndpoint(new URL(request.url).pathname),
        method: request.method,
        statusCode: finalResponse.status,
        wallMs: Date.now() - reqT0,
      });
      return finalResponse;
    } catch (error) {
      console.error('Unhandled error:', error);
      const response = addCorsHeaders(
        jsonResponse(
          {
            error: {
              code: 'INTERNAL_ERROR',
              message: 'An unexpected error occurred',
              details: error instanceof Error ? error.message : String(error),
            },
          },
          500
        ),
        request,
        env
      );
      trackApiRequest(env, {
        endpoint: normalizeEndpoint(new URL(request.url).pathname),
        method: request.method,
        statusCode: 500,
        wallMs: Date.now() - reqT0,
      });
      return response;
    }
  },
};

/**
 * GET /api/songs - List all songs
 */
async function handleGetSongs(request: Request, env: Env): Promise<Response> {
  try {
    // Get all metadata from R2
    const metas = await listMetas(env);
    
    // Sort by createdAt descending (updatedAt changes on retranslation)
    const sortedMetas = metas.sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const responseBody: SongsListResponse = { songs: sortedMetas };
    
    // Compute ETag from sorted response body
    const bodyJson = JSON.stringify(responseBody);
    const etag = `"${await generateFullHash(bodyJson)}"`;
    
    // Check If-None-Match header
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch === etag) {
      // Return 304 Not Modified with no body
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'public, max-age=60',
        },
      });
    }

    return jsonResponse(responseBody, 200, {
      'Cache-Control': 'public, max-age=60',
      'ETag': etag,
    });
  } catch (error) {
    console.error('Error in handleGetSongs:', error);
    return jsonResponse(
      {
        error: {
          code: 'STORAGE_ERROR',
          message: 'Failed to retrieve songs list',
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500
    );
  }
}

/**
 * Helper to remove tokens from a LyricLesson
 */
function omitTokens(lesson: LyricLesson): LyricLesson {
  return {
    ...lesson,
    sections: lesson.sections.map(section => ({
      ...section,
      lines: section.lines.map(line => {
        const { tokens, ...lineWithoutTokens } = line;
        return { ...lineWithoutTokens, tokens: [] } as LyricLine;
      })
    }))
  };
}

/**
 * GET /api/songs/:songId - Get a specific song
 */
async function handleGetSong(request: Request, env: Env, songId: string): Promise<Response> {
  try {
    // Validate songId format (basic check)
    if (!songId || songId.includes('..') || songId.includes('/')) {
      return jsonResponse(
        {
          error: {
            code: 'INVALID_SONG_ID',
            message: 'Invalid song ID format',
          },
        },
        400
      );
    }

    const song = await getSong(env, songId);

    if (!song) {
      return jsonResponse(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'Song not found',
          },
        },
        404
      );
    }

    // Check if tokens should be excluded
    const url = new URL(request.url);
    const includeTokens = url.searchParams.get('tokens') !== 'false';
    
    const responseData = includeTokens ? song : omitTokens(song);

    // Return the LyricLesson JSON directly
    return jsonResponse(responseData, 200);
  } catch (error) {
    console.error('Error in handleGetSong:', error);
    return jsonResponse(
      {
        error: {
          code: 'STORAGE_ERROR',
          message: 'Failed to retrieve song',
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500
    );
  }
}

/**
 * DELETE /api/songs/:songId - Delete a song
 */
async function handleDeleteSong(_request: Request, env: Env, songId: string): Promise<Response> {
  try {
    if (!songId || songId.trim() === '') {
      return jsonResponse(
        { error: { code: 'INVALID_SONG_ID', message: 'Song ID is required' } },
        400
      );
    }

    // Check if song exists
    const song = await getSong(env, songId);
    if (!song) {
      return jsonResponse(
        { error: { code: 'NOT_FOUND', message: 'Song not found' } },
        404
      );
    }

    // Delete the song
    await deleteSong(env, songId);

    return jsonResponse({ success: true, songId }, 200);
  } catch (error) {
    console.error('Error in handleDeleteSong:', error);
    return jsonResponse(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to delete song',
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500
    );
  }
}

/**
 * POST /api/jsonify — Enqueue a song generation job; returns jobId immediately (202)
 */
async function handleJsonify(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return jsonResponse({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } }, 400);
    }

    let validatedRequest;
    try {
      validatedRequest = validateJsonifyRequest(body);
    } catch (error) {
      if (error instanceof ValidationError) {
        return jsonResponse({ error: { code: error.code, message: error.message, details: error.details } }, 400);
      }
      throw error;
    }

    const { rawLyrics, titleHint, artistHint, language } = validatedRequest;
    const imageUrl = typeof (body as any).imageUrl === 'string' ? (body as any).imageUrl : undefined;
    const normalizedLyrics = normalizeLyrics(rawLyrics);

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Write pending job status to R2 so the client can poll immediately
    await putJob(env, {
      jobId,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    // Enqueue the generation work
    await env.GENERATION_QUEUE.send({
      jobId,
      rawLyrics: normalizedLyrics,
      titleHint,
      artistHint,
      imageUrl,
      targetLang: language!.target,
      learnerLang: language!.learner,
    });

    const responseBody: JsonifyQueuedResponse = { jobId };
    return jsonResponse(responseBody, 202);
  } catch (error) {
    console.error('Error in handleJsonify:', error);
    return jsonResponse(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: error instanceof Error ? error.message : String(error) } },
      500
    );
  }
}

/**
 * GET /api/jobs/:jobId — Poll generation job status
 */
async function handleGetJob(_request: Request, env: Env, jobId: string): Promise<Response> {
  if (!jobId || jobId.includes('..') || jobId.includes('/')) {
    return jsonResponse({ error: { code: 'INVALID_JOB_ID', message: 'Invalid job ID' } }, 400);
  }
  const job = await getJob(env, jobId);
  if (!job) {
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Job not found' } }, 404);
  }
  return jsonResponse(job, 200);
}

/**
 * Queue consumer — runs the actual OpenAI generation for a queued job
 */
async function processGenerationJob(env: Env, msg: JsonifyQueueMessage): Promise<void> {
  const { jobId, rawLyrics, titleHint, artistHint, imageUrl, feedback, targetLang, learnerLang, isRetranslate } = msg;
  const jobT0 = Date.now();

  const updateJob = async (patch: Partial<JobStatus>) => {
    const existing = (await getJob(env, jobId)) ?? {
      jobId,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await putJob(env, { ...existing, ...patch, updatedAt: new Date().toISOString() });
  };

  try {
    // Generate a temporary song ID for use during generation
    const tempSongId = await generateSongId(titleHint || 'untitled', rawLyrics);

    const { lesson, usage: openaiUsage, timing } = await generateLyricLesson(
      env,
      rawLyrics,
      titleHint,
      artistHint,
      tempSongId,
      targetLang,
      learnerLang,
      feedback
    );

    const validatedLesson = validateLyricLesson(lesson);

    let finalSongId = await generateSongId(validatedLesson.title, rawLyrics);
    if (await getSong(env, finalSongId)) {
      let v = 2;
      while (await getSong(env, `${finalSongId}-v${v}`)) v++;
      finalSongId = `${finalSongId}-v${v}`;
    }
    validatedLesson.lessonId = finalSongId;

    await putSong(env, finalSongId, validatedLesson);
    await putMeta(env, {
      songId: finalSongId,
      title: validatedLesson.title,
      artist: validatedLesson.source.artist,
      imageUrl,
      language: { target: targetLang, learner: learnerLang },
      openaiUsage,
    });

    await updateJob({ status: 'done', songId: finalSongId });
    console.log(`[queue] job ${jobId} done → ${finalSongId}`);

    trackGeneration(env, {
      type: isRetranslate ? 'retranslate' : 'fresh',
      status: 'done',
      title: validatedLesson.title,
      artist: validatedLesson.source.artist ?? '',
      targetLang,
      learnerLang,
      wallMs: Date.now() - jobT0,
      phaseBaseMs: timing.phaseBaseMs,
      phaseParallelMs: timing.phaseParallelMs,
      totalLines: timing.totalLines,
      uniqueLines: timing.uniqueLines,
      promptTokens: openaiUsage.promptTokens,
      completionTokens: openaiUsage.completionTokens,
      costUsd: openaiUsage.estimatedCostUSD,
      errorCount: validatedLesson.generationErrors?.length ?? 0,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[queue] job ${jobId} failed:`, errMsg);
    await updateJob({ status: 'error', errorMessage: errMsg });

    trackGeneration(env, {
      type: isRetranslate ? 'retranslate' : 'fresh',
      status: 'error',
      title: titleHint ?? 'unknown',
      artist: artistHint ?? '',
      errorMessage: errMsg,
      targetLang,
      learnerLang,
      wallMs: Date.now() - jobT0,
      phaseBaseMs: 0,
      phaseParallelMs: 0,
      totalLines: 0,
      uniqueLines: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      errorCount: 1,
    });
  }
}

/**
 * PATCH /api/songs/:songId/lines/:lineId — manually update one line's translation fields
 */
async function handleUpdateLine(request: Request, env: Env, songId: string, lineId: string): Promise<Response> {
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return jsonResponse({ error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400);

    const textUpdates: Record<string, string> = {};
    for (const field of ['roman', 'wordByWord', 'direct', 'natural'] as const) {
      if (typeof body[field] === 'string') textUpdates[field] = body[field] as string;
    }

    const updated = await updateLine(env, songId, lineId, { text: textUpdates });
    if (!updated) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Song or line not found' } }, 404);

    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
  }
}

/**
 * POST /api/songs/:songId/lines/:lineId/retranslate — AI re-translate one line with optional feedback
 */
async function handleRetranslateLine(request: Request, env: Env, songId: string, lineId: string): Promise<Response> {
  const t0 = Date.now();
  try {
    const body = await request.json().catch(() => null) as { feedback?: string } | null;
    const feedback = typeof body?.feedback === 'string' ? body.feedback.trim() : undefined;

    const song = await getSong(env, songId);
    if (!song) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Song not found' } }, 404);

    const allLines = song.sections.flatMap(s =>
      s.lines
        .filter(l => !l.isInstrumental)
        .map(l => ({ lineId: l.lineId, target: l.text.target, roman: l.text.roman }))
    );
    const targetIdx = allLines.findIndex(l => l.lineId === lineId);
    if (targetIdx === -1) {
      return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Line not found' } }, 404);
    }
    const contextLines = allLines.slice(Math.max(0, targetIdx - 3), targetIdx + 4);

    const result = await retranslateLine(env, lineId, contextLines, song.title, song.source?.artist ?? '', feedback);

    const updated = await updateLine(env, songId, lineId, {
      text: { roman: result.roman, wordByWord: result.wordByWord, direct: result.direct, natural: result.natural },
      tokens: result.tokens,
    });
    if (!updated) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Line not found after retranslate' } }, 404);

    trackRetranslateLine(env, { status: 'done', songId, lineId, hasFeedback: !!feedback, wallMs: Date.now() - t0 });
    return jsonResponse(result, 200);
  } catch (error) {
    console.error('Error in handleRetranslateLine:', error);
    trackRetranslateLine(env, { status: 'error', songId, lineId, hasFeedback: false, wallMs: Date.now() - t0 });
    return jsonResponse({ error: { code: 'RETRANSLATE_ERROR', message: String(error) } }, 502);
  }
}

/**
 * POST /api/songs/:songId/retranslate — Re-run AI on the whole song with optional feedback, saves as new version
 */
async function handleRetranslateSong(request: Request, env: Env, songId: string): Promise<Response> {
  try {
    const body = await request.json().catch(() => null) as { feedback?: string } | null;
    const feedback = typeof body?.feedback === 'string' ? body.feedback.trim() : undefined;

    const song = await getSong(env, songId);
    if (!song) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Song not found' } }, 404);

    const meta = await getMeta(env, songId);
    // Use roman (uniform Latin) not target (script can switch e.g. Devanagari → Gurmukhi
    // mid-song), which causes the model to stop at the script boundary.
    const rawLyrics = song.sections
      .flatMap(s => s.lines.filter(l => !l.isInstrumental).map(l => l.text.roman))
      .join('\n');

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    await putJob(env, { jobId, status: 'pending', createdAt: now, updatedAt: now });

    await env.GENERATION_QUEUE.send({
      jobId,
      rawLyrics,
      titleHint: song.title,
      artistHint: song.source?.artist,
      imageUrl: meta?.imageUrl,
      feedback,
      targetLang: meta?.language?.target ?? 'hi',
      learnerLang: meta?.language?.learner ?? 'en',
      isRetranslate: true,
    });

    return jsonResponse({ jobId }, 202);
  } catch (error) {
    console.error('Error in handleRetranslateSong:', error);
    return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
  }
}

/**
 * DELETE /api/songs/:songId/lines/:lineId — remove a line (typically an instrumental placeholder)
 */
async function handleDeleteLine(_request: Request, env: Env, songId: string, lineId: string): Promise<Response> {
  try {
    const updated = await deleteLineFromSong(env, songId, lineId);
    if (!updated) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Song or line not found' } }, 404);
    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
  }
}

/**
 * POST /api/songs/:songId/lines/:lineId/instrumental — insert an instrumental line before lineId
 */
async function handleInsertInstrumental(_request: Request, env: Env, songId: string, lineId: string): Promise<Response> {
  try {
    const updated = await insertInstrumentalBefore(env, songId, lineId);
    if (!updated) return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Song or line not found' } }, 404);
    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
  }
}

/**
 * POST /api/lookup - Find candidate Devanagari lyrics for a given title/artist
 */
async function handleLookup(request: Request, env: Env): Promise<Response> {
  const t0 = Date.now();
  try {
    const body = await request.json().catch(() => null) as { title?: unknown; artist?: unknown } | null;
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      return jsonResponse(
        { error: { code: 'INVALID_REQUEST', message: 'title is required' } },
        400
      );
    }
    const title = body.title.trim().slice(0, 200);
    const artist = typeof body.artist === 'string' ? body.artist.trim().slice(0, 200) : undefined;

    const result = await lookupLyrics(env, title, artist);

    const found = result.candidates.length > 0;
    const notes = result.candidates[0]?.notes ?? '';
    const { source, script } = found ? parseLookupSource(notes) : { source: 'none', script: 'none' };
    trackLookup(env, { source, script, title, found, wallMs: Date.now() - t0 });

    return jsonResponse(result, 200);
  } catch (error) {
    console.error('Error in handleLookup:', error);
    trackLookup(env, { source: 'none', script: 'none', title: '', found: false, wallMs: Date.now() - t0 });
    return jsonResponse(
      {
        error: {
          code: 'LOOKUP_ERROR',
          message: 'Failed to look up lyrics',
          details: error instanceof Error ? error.message : String(error),
        },
      },
      502
    );
  }
}

// In-memory Spotify token cache (lives as long as the worker isolate)
let spotifyTokenCache: { token: string; expiresAt: number } | null = null;

async function getSpotifyAppToken(clientId: string, clientSecret: string): Promise<string> {
  if (spotifyTokenCache && Date.now() < spotifyTokenCache.expiresAt) {
    return spotifyTokenCache.token;
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json() as any;
  if (!data.access_token) {
    console.error('Spotify token exchange failed:', JSON.stringify(data));
    throw new Error(`Spotify auth failed: ${data.error_description ?? data.error ?? 'unknown'}`);
  }
  spotifyTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return spotifyTokenCache.token;
}

/**
 * POST /api/admin/reset-updated-at — One-shot: set updatedAt = createdAt for all songs.
 */
async function handleResetUpdatedAt(env: Env): Promise<Response> {
  const metas = await listMetas(env);
  for (const meta of metas) {
    const patched = { ...meta, updatedAt: meta.createdAt };
    await env.BUCKET.put(`meta/${meta.songId}.json`, JSON.stringify(patched), {
      httpMetadata: { contentType: 'application/json' },
    });
  }
  return jsonResponse({ reset: metas.length });
}

/**
 * POST /api/admin/backfill-images — One-shot: find and store Spotify album art for songs missing it.
 */
async function handleBackfillImages(env: Env): Promise<Response> {
  const metas = await listMetas(env);
  const missing = metas.filter((m) => !m.imageUrl);

  const results: { songId: string; title: string; found: boolean }[] = [];

  for (const meta of missing) {
    const q = [meta.title, meta.artist].filter(Boolean).join(' ');
    try {
      const token = await getSpotifyAppToken(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET);
      const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`;
      const res = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json() as any;
      const item = data.tracks?.items?.[0];
      if (item) {
        const images: { url: string; height: number }[] = item.album?.images ?? [];
        const smallest = images.sort((a, b) => a.height - b.height)[0];
        if (smallest?.url) {
          // Write directly to R2 preserving original createdAt AND updatedAt so sort order is unchanged
          const patched = { ...meta, imageUrl: smallest.url };
          await env.BUCKET.put(`meta/${meta.songId}.json`, JSON.stringify(patched), {
            httpMetadata: { contentType: 'application/json' },
          });
          results.push({ songId: meta.songId, title: meta.title, found: true });
          continue;
        }
      }
    } catch (e) {
      console.error(`backfill failed for ${meta.songId}:`, e);
    }
    results.push({ songId: meta.songId, title: meta.title, found: false });
  }

  return jsonResponse({
    scanned: metas.length,
    alreadyHadImage: metas.length - missing.length,
    updated: results.filter((r) => r.found).length,
    notFound: results.filter((r) => !r.found).length,
    results,
  });
}

/**
 * GET /api/spotify/search?q=... — Proxy Spotify catalogue search (no user auth required)
 */
async function handleSpotifySearch(request: Request, env: Env): Promise<Response> {
  const q = new URL(request.url).searchParams.get('q')?.trim();
  if (!q) return jsonResponse({ error: { code: 'BAD_REQUEST', message: 'q is required' } }, 400);

  const token = await getSpotifyAppToken(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET);

  const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=10`;
  const res = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json() as any;
  if (data.error) throw new Error(`Spotify search failed: ${data.error.message ?? data.error}`);

  const tracks = (data.tracks?.items ?? []).map((item: any) => {
    const images: { url: string; height: number }[] = item.album?.images ?? [];
    const smallest = images.sort((a, b) => a.height - b.height)[0];
    return {
      id: item.id,
      name: item.name,
      artist: (item.artists ?? []).map((a: any) => a.name).filter(Boolean).join(', '),
      imageUrl: smallest?.url ?? null,
    };
  });

  return jsonResponse({ tracks });
}

/**
 * Helper to create JSON responses
 */
function jsonResponse(data: any, status: number = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}
