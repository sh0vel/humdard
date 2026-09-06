/**
 * Cloudflare Worker - Lyric Learning API
 * Main entry point with routing and request handlers
 */

import { Env, JsonifyQueuedResponse, JsonifyQueueMessage, SongsListResponse, LyricLesson, LyricLine, JobStatus } from './types';
import { handleCorsPreFlight, addCorsHeaders } from './cors';
import { getSong, putSong, listMetas, putMeta, getMeta, updateLine, deleteLineFromSong, getJob, putJob, insertInstrumentalBefore, songCacheKey, lyricsContentKey, getCachedSongId, setCachedSongId, getUserSongs, addSongToUser, removeSongFromUser, getUserFavorites, addFavorite, removeFavorite, addUserPendingJob, removeUserPendingJob, getUserPendingJobIds } from './storage';
import { generateLyricLesson, retranslateLine } from './openai';
import { lookupLyrics, cleanTitle } from './lookup';
import { validateJsonifyRequest, validateLyricLesson, ValidationError, normalizeLyrics } from './validate';
import { generateSongId, generateFullHash } from './utils';
import { trackApiRequest, trackGeneration, trackRetranslateLine, trackLookup, normalizeEndpoint, parseLookupSource } from './analytics';
import { requireAuth } from './auth';

/**
 * Main request handler + queue consumer
 */
export default {
  async queue(batch: MessageBatch<JsonifyQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processGenerationJob(env, message.body);
      } catch (err) {
        // processGenerationJob has its own catch; this fires only if updateJob itself fails (e.g. R2 down).
        // Best-effort: mark the job as error so iOS polling exits cleanly.
        const { jobId, userId } = message.body;
        console.error(`[queue] unhandled exception for job ${jobId}:`, err);
        try {
          const existing = await getJob(env, jobId);
          if (existing && existing.status === 'pending') {
            await putJob(env, { ...existing, status: 'error', errorMessage: 'Generation failed unexpectedly', updatedAt: new Date().toISOString() });
          }
          if (userId) await removeUserPendingJob(env, userId, jobId);
        } catch { /* ignore — ack regardless */ }
      }
      message.ack(); // Always ack — job status lives in R2, not the queue
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

      // Auth check for protected routes
      let authedUserId: string | undefined;
      if (isProtectedRoute(path, request.method)) {
        const auth = await requireAuth(request, env);
        if (auth instanceof Response) {
          return addCorsHeaders(auth, request, env);
        }
        authedUserId = auth.userId;
      }

      // Route requests
      let response: Response;

      if (path === '/api/v1/songs' && request.method === 'GET') {
        response = await handleGetSongs(request, env, authedUserId!);
      } else if (path.startsWith('/api/v1/songs/') && request.method === 'GET') {
        const songId = path.split('/api/v1/songs/')[1];
        response = await handleGetSong(request, env, songId);
      } else if (/^\/api\/v1\/songs\/[^/]+\/lines\/[^/]+$/.test(path) && request.method === 'DELETE') {
        const [, , , , songId, , lineId] = path.split('/');
        response = await handleDeleteLine(request, env, songId, lineId);
      } else if (path.startsWith('/api/v1/songs/') && request.method === 'DELETE') {
        const songId = path.split('/api/v1/songs/')[1];
        response = await handleDeleteSong(request, env, songId, authedUserId!);
      } else if (/^\/api\/v1\/songs\/[^/]+\/lines\/[^/]+$/.test(path) && request.method === 'PATCH') {
        const [, , , , songId, , lineId] = path.split('/');
        response = await handleUpdateLine(request, env, songId, lineId);
      } else if (/^\/api\/v1\/songs\/[^/]+\/lines\/[^/]+\/retranslate$/.test(path) && request.method === 'POST') {
        const [, , , , songId, , lineId] = path.split('/');
        response = await handleRetranslateLine(request, env, songId, lineId);
      } else if (/^\/api\/v1\/songs\/[^/]+\/lines\/[^/]+\/instrumental$/.test(path) && request.method === 'POST') {
        const [, , , , songId, , lineId] = path.split('/');
        response = await handleInsertInstrumental(request, env, songId, lineId);
      } else if (/^\/api\/v1\/songs\/[^/]+\/retranslate$/.test(path) && request.method === 'POST') {
        const songId = path.split('/')[4];
        response = await handleRetranslateSong(request, env, songId, authedUserId);
      } else if (path === '/api/v1/jsonify' && request.method === 'POST') {
        response = await handleJsonify(request, env, authedUserId);
      } else if (path === '/api/v1/jobs/pending' && request.method === 'GET') {
        response = await handleGetPendingJobs(env, authedUserId!);
      } else if (path.startsWith('/api/v1/jobs/') && request.method === 'GET') {
        const jobId = path.split('/api/v1/jobs/')[1];
        response = await handleGetJob(request, env, jobId);
      } else if (path === '/api/v1/lookup' && request.method === 'POST') {
        response = await handleLookup(request, env);
      } else if (path === '/api/v1/spotify/search' && request.method === 'GET') {
        response = await handleSpotifySearch(request, env);
      } else if (path === '/api/v1/admin/backfill-images' && request.method === 'POST') {
        response = await handleBackfillImages(env);
      } else if (path === '/api/v1/admin/reset-updated-at' && request.method === 'POST') {
        response = await handleResetUpdatedAt(env);
      } else if (path === '/api/v1/admin/backfill-cache' && request.method === 'POST') {
        response = await handleBackfillCache(env);
      } else if (path === '/api/v1/admin/seed-user-songs' && request.method === 'POST') {
        response = await handleSeedUserSongs(request, env);
      } else if (path === '/api/v1/admin/backfill-titles' && request.method === 'POST') {
        response = await handleBackfillTitles(env);
      } else if (path === '/api/v1/admin/patch-meta' && request.method === 'POST') {
        response = await handlePatchMeta(request, env);
      } else if (path === '/api/v1/admin/list-metas' && request.method === 'GET') {
        const metas = await listMetas(env);
        response = jsonResponse(metas);
      } else if (path === '/api/v1/favorites' && request.method === 'GET') {
        response = await handleGetFavorites(env, authedUserId!);
      } else if (path === '/api/v1/favorites' && request.method === 'POST') {
        response = await handleAddFavorite(request, env, authedUserId!);
      } else if (request.method === 'DELETE' && /^\/api\/v1\/favorites\/[^/]+$/.test(path)) {
        const lineId = path.split('/api/v1/favorites/')[1];
        response = await handleDeleteFavorite(env, authedUserId!, lineId);
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
async function handleGetSongs(request: Request, env: Env, userId: string): Promise<Response> {
  try {
    const songIds = await getUserSongs(env, userId);
    const metaResults = await Promise.all(songIds.map((id) => getMeta(env, id)));
    const sortedMetas = (metaResults.filter((m) => m !== null) as import('./types').SongMetadata[])
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

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
async function handleDeleteSong(_request: Request, env: Env, songId: string, userId: string): Promise<Response> {
  try {
    if (!songId || songId.trim() === '') {
      return jsonResponse(
        { error: { code: 'INVALID_SONG_ID', message: 'Song ID is required' } },
        400
      );
    }

    await removeSongFromUser(env, userId, songId);

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
async function handleJsonify(request: Request, env: Env, userId?: string): Promise<Response> {
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

    const { rawLyrics, titleHint: rawTitleHint, artistHint, language } = validatedRequest;
    const titleHint = rawTitleHint ? cleanTitle(rawTitleHint) : rawTitleHint;
    const imageUrl = typeof (body as any).imageUrl === 'string' ? (body as any).imageUrl : undefined;
    const force = (body as any).force === true;
    const normalizedLyrics = normalizeLyrics(rawLyrics);

    // Cache check: skip when force=true
    // Keyed on lyrics content so different lyrics always produce a fresh generation.
    // Also validates the cached song still exists (handles deleted songs).
    if (!force) {
      const hash = await lyricsContentKey(normalizedLyrics);
      const cachedSongId = await getCachedSongId(env, hash);
      if (cachedSongId) {
        const cachedSong = await getSong(env, cachedSongId);
        if (cachedSong) {
          const jobId = crypto.randomUUID();
          const now = new Date().toISOString();
          await putJob(env, { jobId, status: 'done', songId: cachedSongId, createdAt: now, updatedAt: now });
          if (userId) await addSongToUser(env, userId, cachedSongId);
          console.log(`[jsonify] lyrics cache hit → ${cachedSongId}`);
          return jsonResponse({ jobId } as JsonifyQueuedResponse, 202);
        }
        console.log(`[jsonify] stale lyrics cache for ${cachedSongId} — song deleted, regenerating`);
      }
    }

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Write pending job status to R2 so the client can poll immediately
    await putJob(env, {
      jobId,
      status: 'pending',
      userId,
      title: titleHint,
      imageUrl,
      createdAt: now,
      updatedAt: now,
    });
    if (userId) await addUserPendingJob(env, userId, jobId);

    // Enqueue the generation work
    await env.GENERATION_QUEUE.send({
      jobId,
      rawLyrics: normalizedLyrics,
      titleHint,
      artistHint,
      imageUrl,
      targetLang: language!.target,
      learnerLang: language!.learner,
      userId,
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
 * GET /api/v1/jobs/pending — Return all pending jobs for the authenticated user
 */
async function handleGetPendingJobs(env: Env, userId: string): Promise<Response> {
  try {
    const jobIds = await getUserPendingJobIds(env, userId);
    const jobs = (await Promise.all(jobIds.map((id) => getJob(env, id)))).filter((j): j is JobStatus => j !== null);
    return jsonResponse({ jobs });
  } catch (error) {
    return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: String(error) } }, 500);
  }
}

// ── Retry helpers ────────────────────────────────────────────────────────────

const MAX_GENERATION_ATTEMPTS = 3;

// Full jitter: sleep = random(0, min(cap, base * 2^attempt))
// Avoids thundering herd on correlated failures better than equal or decorrelated jitter.
function jitteredBackoffMs(attempt: number, baseMs = 2_000, capMs = 30_000): number {
  const ceiling = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.random() * ceiling;
}

function isTransient(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // OpenAI rate limit, overload, server errors, network failures
  return (
    msg.includes('429') || msg.includes('rate limit') || msg.includes('overloaded') ||
    msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') ||
    msg.includes('timeout') || msg.includes('timed out') ||
    msg.includes('network') || msg.includes('fetch failed') || msg.includes('econnreset')
  );
}

/**
 * Queue consumer — runs the actual OpenAI generation for a queued job
 */
async function processGenerationJob(env: Env, msg: JsonifyQueueMessage): Promise<void> {
  const { jobId, rawLyrics, titleHint, artistHint, imageUrl, feedback, targetLang, learnerLang, isRetranslate, userId } = msg;
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
    const tempSongId = await generateSongId(titleHint || 'untitled', rawLyrics);

    // Retry loop with full jitter — only wraps the OpenAI call
    let lesson: Awaited<ReturnType<typeof generateLyricLesson>>['lesson'] | undefined;
    let openaiUsage!: Awaited<ReturnType<typeof generateLyricLesson>>['usage'];
    let timing!: Awaited<ReturnType<typeof generateLyricLesson>>['timing'];
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delayMs = jitteredBackoffMs(attempt);
        console.log(`[queue] job ${jobId} retry ${attempt}/${MAX_GENERATION_ATTEMPTS - 1} after ${Math.round(delayMs)}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
      try {
        ({ lesson, usage: openaiUsage, timing } = await generateLyricLesson(
          env, rawLyrics, tempSongId, targetLang, learnerLang, feedback
        ));
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        if (!isTransient(err)) {
          console.warn(`[queue] job ${jobId} permanent error, no retry:`, err instanceof Error ? err.message : err);
          break;
        }
        console.warn(`[queue] job ${jobId} transient error (attempt ${attempt + 1}):`, err instanceof Error ? err.message : err);
      }
    }
    if (lastError !== undefined) throw lastError;

    const validatedLesson = validateLyricLesson(lesson!);

    // Always use the Spotify/user-provided title — never the AI's version (which may be native script)
    const songTitle = titleHint ?? validatedLesson.title;
    validatedLesson.title = songTitle;

    let finalSongId = await generateSongId(songTitle, rawLyrics);
    if (await getSong(env, finalSongId)) {
      let v = 2;
      while (await getSong(env, `${finalSongId}-v${v}`)) v++;
      finalSongId = `${finalSongId}-v${v}`;
    }
    validatedLesson.lessonId = finalSongId;

    await putSong(env, finalSongId, validatedLesson);
    await putMeta(env, {
      songId: finalSongId,
      title: songTitle,
      artist: artistHint ?? validatedLesson.source.artist,
      imageUrl,
      language: { target: targetLang, learner: learnerLang },
      openaiUsage,
    });

    // Write to cache keyed on lyrics content
    const lyricsHash = await lyricsContentKey(normalizeLyrics(rawLyrics));
    await setCachedSongId(env, lyricsHash, finalSongId, titleHint ?? '', artistHint ?? '');

    if (userId) await addSongToUser(env, userId, finalSongId);
    if (userId) await removeUserPendingJob(env, userId, jobId);

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
    if (userId) await removeUserPendingJob(env, userId, jobId);

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

    const result = await retranslateLine(env, lineId, contextLines, feedback);

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
async function handleRetranslateSong(request: Request, env: Env, songId: string, userId?: string): Promise<Response> {
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

    const englishTitle = meta?.title ?? song.title;
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    await putJob(env, { jobId, status: 'pending', userId, title: englishTitle, imageUrl: meta?.imageUrl, createdAt: now, updatedAt: now });
    if (userId) await addUserPendingJob(env, userId, jobId);

    await env.GENERATION_QUEUE.send({
      jobId,
      rawLyrics,
      titleHint: englishTitle,
      artistHint: song.source?.artist,
      imageUrl: meta?.imageUrl,
      feedback,
      targetLang: meta?.language?.target ?? 'hi',
      learnerLang: meta?.language?.learner ?? 'en',
      isRetranslate: true,
      userId,
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
 * Returns true for routes that require a valid Clerk session token.
 * Open routes: GET /api/v1/songs/:id (shared links), GET /api/v1/jobs/:id.
 */
function isProtectedRoute(path: string, method: string): boolean {
  if (path === '/api/v1/songs' && method === 'GET') return true;
  if (path === '/api/v1/jsonify' && method === 'POST') return true;
  if (path === '/api/v1/lookup' && method === 'POST') return true;
  if (method === 'DELETE' && /^\/api\/v1\/songs\/[^/]+$/.test(path)) return true;
  if (method === 'PATCH' && path.includes('/lines/')) return true;
  if (method === 'POST' && /^\/api\/v1\/songs\/[^/]+\/retranslate$/.test(path)) return true;
  if (method === 'POST' && path.includes('/lines/')) return true;
  if (path === '/api/v1/favorites' && (method === 'GET' || method === 'POST')) return true;
  if (method === 'DELETE' && /^\/api\/v1\/favorites\/[^/]+$/.test(path)) return true;
  if (path === '/api/v1/jobs/pending' && method === 'GET') return true;
  return false;
}

async function handleGetFavorites(env: Env, userId: string): Promise<Response> {
  const favorites = await getUserFavorites(env, userId);
  return jsonResponse({ favorites });
}

async function handleAddFavorite(request: Request, env: Env, userId: string): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof (body as any).lineId !== 'string') {
    return jsonResponse({ error: { code: 'INVALID_REQUEST', message: 'lineId required' } }, 400);
  }
  await addFavorite(env, userId, body as any);
  return jsonResponse({ ok: true });
}

async function handleDeleteFavorite(env: Env, userId: string, lineId: string): Promise<Response> {
  await removeFavorite(env, userId, lineId);
  return jsonResponse({ ok: true });
}

/**
 * POST /api/admin/seed-user-songs — One-shot: assign all existing songs to a given userId.
 * Body: { userId: string }
 */
async function handleSeedUserSongs(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => null) as { userId?: unknown } | null;
  if (!body || typeof body.userId !== 'string' || !body.userId.trim()) {
    return jsonResponse({ error: { code: 'INVALID_REQUEST', message: 'userId is required' } }, 400);
  }
  const userId = body.userId.trim();
  const metas = await listMetas(env);
  let added = 0;
  for (const meta of metas) {
    await addSongToUser(env, userId, meta.songId);
    added++;
  }
  return jsonResponse({ userId, added });
}

/**
 * POST /api/admin/backfill-cache — One-shot: populate cache/{hash}/meta.json for all existing songs.
 */
async function handleBackfillCache(env: Env): Promise<Response> {
  const metas = await listMetas(env);
  let written = 0;
  let skipped = 0;

  for (const meta of metas) {
    if (!meta.title || !meta.artist) { skipped++; continue; }
    const hash = await songCacheKey(meta.title, meta.artist);
    const existing = await getCachedSongId(env, hash);
    if (existing) { skipped++; continue; }
    await setCachedSongId(env, hash, meta.songId, meta.title, meta.artist);
    written++;
  }

  return jsonResponse({ total: metas.length, written, skipped });
}

/**
 * POST /api/v1/admin/backfill-titles — Patch any song whose stored title doesn't match
 * the original English title stored in the Spotify cache entry.
 */
async function handleBackfillTitles(env: Env): Promise<Response> {
  // Collect all cache entries (they store the original English titleHint)
  const allKeys: string[] = [];
  let cursor: string | undefined;
  let truncated = true;
  while (truncated) {
    const listed = await env.BUCKET.list({ prefix: 'cache/', cursor });
    allKeys.push(...listed.objects.map(o => o.key).filter(k => k.endsWith('/meta.json')));
    truncated = listed.truncated;
    cursor = listed.truncated ? listed.cursor : undefined;
  }

  const results: { songId: string; from: string; to: string }[] = [];
  let skipped = 0;

  for (const key of allKeys) {
    const obj = await env.BUCKET.get(key);
    if (!obj) { skipped++; continue; }
    const cache = JSON.parse(await obj.text()) as { title: string; artist?: string; songId: string };
    if (!cache.songId || !cache.title) { skipped++; continue; }

    const meta = await getMeta(env, cache.songId);
    if (!meta) { skipped++; continue; }

    // Only apply if the cache title is ASCII/Latin (skip Devanagari cache entries)
    if (!/^[\x20-\x7E]+$/.test(cache.title)) { skipped++; continue; }

    const needsPatch = meta.title !== cache.title;
    if (!needsPatch) { skipped++; continue; }

    // Patch metadata
    await env.BUCKET.put(`meta/${cache.songId}.json`, JSON.stringify({
      ...meta,
      title: cache.title,
      ...(cache.artist ? { artist: cache.artist } : {}),
    }), { httpMetadata: { contentType: 'application/json' } });

    // Patch lesson JSON title too
    const song = await getSong(env, cache.songId);
    if (song && song.title !== cache.title) {
      song.title = cache.title;
      await putSong(env, cache.songId, song);
    }

    results.push({ songId: cache.songId, from: meta.title, to: cache.title });
  }

  return jsonResponse({ scanned: allKeys.length, patched: results.length, skipped, results });
}

/**
 * POST /api/v1/admin/patch-meta — Update title and/or artist for a song.
 * Body: { songId: string, title?: string, artist?: string }
 */
async function handlePatchMeta(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { songId?: string; title?: string; artist?: string };
  if (!body.songId) return jsonResponse({ error: 'songId required' }, 400);
  const existing = await getMeta(env, body.songId);
  if (!existing) return jsonResponse({ error: 'song not found' }, 404);
  const { createdAt: _c, updatedAt: _u, ...rest } = existing;
  const updated = {
    ...rest,
    ...(body.title  !== undefined ? { title:  body.title  } : {}),
    ...(body.artist !== undefined ? { artist: body.artist } : {}),
  };
  await putMeta(env, updated);

  if (body.title !== undefined) {
    const song = await getSong(env, body.songId);
    if (song && song.title !== body.title) {
      song.title = body.title;
      await putSong(env, body.songId, song);
    }
  }

  return jsonResponse({ ok: true, songId: body.songId, title: updated.title, artist: updated.artist });
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
