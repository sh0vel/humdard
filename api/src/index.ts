/**
 * Cloudflare Worker - Lyric Learning API
 * Main entry point with routing and request handlers
 */

import { Env, JsonifyResponse, SongsListResponse, SongMetadata, LyricLesson, LyricLine } from './types';
import { handleCorsPreFlight, addCorsHeaders } from './cors';
import { getSong, putSong, listMetas, putMeta, deleteSong } from './storage';
import { generateLyricLesson } from './openai';
import { validateJsonifyRequest, validateLyricLesson, ValidationError, normalizeLyrics } from './validate';
import { generateSongId, generateFullHash } from './utils';

/**
 * Main request handler
 */
export default {
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
      } else if (path.startsWith('/api/songs/') && request.method === 'DELETE') {
        const songId = path.split('/api/songs/')[1];
        response = await handleDeleteSong(request, env, songId);
      } else if (path === '/api/jsonify' && request.method === 'POST') {
        response = await handleJsonify(request, env);
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
async function handleDeleteSong(request: Request, env: Env, songId: string): Promise<Response> {
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
 * POST /api/jsonify - Convert raw lyrics to structured JSON
 */
async function handleJsonify(request: Request, env: Env): Promise<Response> {
  try {
    // Parse request body
    const body = await request.json().catch(() => null);
    
    if (!body) {
      return jsonResponse(
        {
          error: {
            code: 'INVALID_JSON',
            message: 'Request body must be valid JSON',
          },
        },
        400
      );
    }

    // Validate request
    let validatedRequest;
    try {
      validatedRequest = validateJsonifyRequest(body);
    } catch (error) {
      if (error instanceof ValidationError) {
        return jsonResponse(
          {
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          },
          400
        );
      }
      throw error;
    }

    const { rawLyrics, titleHint, artistHint, language } = validatedRequest;

    // Normalize lyrics
    const normalizedLyrics = normalizeLyrics(rawLyrics);

    // Generate temporary song ID (will be used in lessonId, then refined)
    const tempTitle = titleHint || 'untitled';
    const tempSongId = await generateSongId(tempTitle, normalizedLyrics);

    // Call OpenAI to generate structured lesson
    let lesson;
    let openaiUsage: { promptTokens: number; completionTokens: number; totalTokens: number; estimatedCostUSD: number } | undefined;
    try {
      const result = await generateLyricLesson(
        env,
        normalizedLyrics,
        titleHint,
        artistHint,
        tempSongId,
        language!.target,
        language!.learner
      );
      lesson = result.lesson;
      openaiUsage = result.usage;
    } catch (error) {
      console.error('OpenAI generation error:', error);
      return jsonResponse(
        {
          error: {
            code: 'AI_GENERATION_ERROR',
            message: 'Failed to generate structured lesson',
            details: error instanceof Error ? error.message : String(error),
          },
        },
        502
      );
    }

    // Validate the generated lesson
    try {
      lesson = validateLyricLesson(lesson);
    } catch (error) {
      if (error instanceof ValidationError) {
        return jsonResponse(
          {
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          },
          502
        );
      }
      throw error;
    }

    // Generate final songId based on actual title from OpenAI
    const finalSongId = await generateSongId(lesson.title, normalizedLyrics);

    // Update lessonId to match songId
    lesson.lessonId = finalSongId;

    // Store the lesson in R2
    try {
      await putSong(env, finalSongId, lesson);
    } catch (error) {
      console.error('Storage error:', error);
      return jsonResponse(
        {
          error: {
            code: 'STORAGE_ERROR',
            message: 'Failed to store lesson',
            details: error instanceof Error ? error.message : String(error),
          },
        },
        500
      );
    }

    // Store metadata to R2
    let songMeta: SongMetadata;
    try {
      songMeta = await putMeta(env, {
        songId: finalSongId,
        title: lesson.title,
        artist: lesson.source.artist,
        language: {
          target: language!.target,
          learner: language!.learner,
        },
        openaiUsage,
      });
    } catch (error) {
      console.error('Metadata storage error:', error);
      return jsonResponse(
        {
          error: {
            code: 'STORAGE_ERROR',
            message: 'Failed to store metadata',
            details: error instanceof Error ? error.message : String(error),
          },
        },
        500
      );
    }

    // Return response
    const responseBody: JsonifyResponse = {
      songId: finalSongId,
      songMeta,
    };

    return jsonResponse(responseBody, 201);
  } catch (error) {
    console.error('Error in handleJsonify:', error);
    return jsonResponse(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
          details: error instanceof Error ? error.message : String(error),
        },
      },
      500
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
