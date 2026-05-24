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
      } else {
        response = jsonResponse(
          { error: { code: 'NOT_FOUND', message: 'Endpoint not found' } },
          404
        );
      }

      // Add CORS headers to response
      return addCorsHeaders(response, request, env);
    } catch (error) {
      console.error('Unhandled error:', error);
      const response = jsonResponse(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
            details: error instanceof Error ? error.message : String(error),
          },
        },
        500
      );
      return addCorsHeaders(response, request, env);
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
    
    // Sort by updatedAt descending
    const sortedMetas = metas.sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
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
  const { jobId, rawLyrics, titleHint, artistHint, targetLang, learnerLang } = msg;

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

    const { lesson, usage: openaiUsage } = await generateLyricLesson(
      env,
      rawLyrics,
      titleHint,
      artistHint,
      tempSongId,
      targetLang,
      learnerLang
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
      language: { target: targetLang, learner: learnerLang },
      openaiUsage,
    });

    await updateJob({ status: 'done', songId: finalSongId });
    console.log(`[queue] job ${jobId} done → ${finalSongId}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[queue] job ${jobId} failed:`, msg);
    await updateJob({ status: 'error', errorMessage: msg });
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

    return jsonResponse(result, 200);
  } catch (error) {
    console.error('Error in handleRetranslateLine:', error);
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

    // Reconstruct raw lyrics from the stored target lines
    const rawLyrics = song.sections
      .flatMap(s => s.lines.map(l => l.text.target))
      .join('\n');

    const meta = await getMeta(env, songId);

    let result;
    try {
      result = await generateLyricLesson(
        env,
        rawLyrics,
        song.title,
        song.source?.artist,
        undefined,
        meta?.language?.target ?? 'hi',
        meta?.language?.learner ?? 'en',
        feedback
      );
    } catch (error) {
      console.error('OpenAI retranslate song error:', error);
      return jsonResponse({ error: { code: 'AI_GENERATION_ERROR', message: String(error) } }, 502);
    }

    const { lesson, usage: openaiUsage } = result;

    // Save as a new versioned copy so the original is preserved
    let newSongId = songId;
    let v = 2;
    while (await getSong(env, `${newSongId.replace(/-v\d+$/, '')}-v${v}`)) v++;
    newSongId = `${newSongId.replace(/-v\d+$/, '')}-v${v}`;
    lesson.lessonId = newSongId;

    await putSong(env, newSongId, lesson);
    const songMeta = await putMeta(env, {
      songId: newSongId,
      title: lesson.title,
      artist: lesson.source.artist,
      language: {
        target: meta?.language?.target ?? 'hi',
        learner: meta?.language?.learner ?? 'en',
      },
      openaiUsage,
    });

    return jsonResponse({ songId: newSongId, songMeta }, 201);
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
    return jsonResponse(result, 200);
  } catch (error) {
    console.error('Error in handleLookup:', error);
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
