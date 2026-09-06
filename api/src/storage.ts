/**
 * R2 storage operations for song data and metadata management
 */

import { Env, LyricLesson, SongMetadata, JobStatus } from './types';

/**
 * Get song key for R2 storage
 */
function getSongKey(songId: string): string {
  return `songs/${songId}.json`;
}

/**
 * Get metadata key for R2 storage
 */
function getMetaKey(songId: string): string {
  return `meta/${songId}.json`;
}

/**
 * Read a song from R2
 */
export async function getSong(
  env: Env,
  songId: string
): Promise<LyricLesson | null> {
  try {
    const object = await env.BUCKET.get(getSongKey(songId));
    if (!object) {
      return null;
    }
    
    const text = await object.text();
    return JSON.parse(text) as LyricLesson;
  } catch (error) {
    console.error('Error reading song from R2:', error);
    throw error;
  }
}

/**
 * Write a song to R2
 */
export async function putSong(
  env: Env,
  songId: string,
  lesson: LyricLesson
): Promise<void> {
  try {
    const json = JSON.stringify(lesson, null, 2);
    await env.BUCKET.put(getSongKey(songId), json, {
      httpMetadata: {
        contentType: 'application/json',
      },
    });
  } catch (error) {
    console.error('Error writing song to R2:', error);
    throw error;
  }
}

/**
 * Read metadata for a specific song from R2
 */
export async function getMeta(
  env: Env,
  songId: string
): Promise<SongMetadata | null> {
  try {
    const object = await env.BUCKET.get(getMetaKey(songId));
    if (!object) {
      return null;
    }
    
    const text = await object.text();
    return JSON.parse(text) as SongMetadata;
  } catch (error) {
    console.error('Error reading metadata from R2:', error);
    return null;
  }
}

/**
 * Write metadata for a song to R2
 */
export async function putMeta(
  env: Env,
  metadata: Omit<SongMetadata, 'createdAt' | 'updatedAt'>
): Promise<SongMetadata> {
  const now = new Date().toISOString();

  // Check if metadata already exists to preserve createdAt
  const existing = await getMeta(env, metadata.songId);

  const songMeta: SongMetadata = {
    ...metadata,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  
  try {
    const json = JSON.stringify(songMeta, null, 2);
    await env.BUCKET.put(getMetaKey(metadata.songId), json, {
      httpMetadata: {
        contentType: 'application/json',
      },
    });
    return songMeta;
  } catch (error) {
    console.error('Error writing metadata to R2:', error);
    throw error;
  }
}

/**
 * Update a single line within a stored song. Returns the updated lesson, or null if not found.
 */
export async function updateLine(
  env: Env,
  songId: string,
  lineId: string,
  updates: { text?: Partial<{ roman: string; wordByWord: string; direct: string; natural: string }>; tokens?: import('./types').LyricToken[] }
): Promise<import('./types').LyricLesson | null> {
  const lesson = await getSong(env, songId);
  if (!lesson) return null;

  let found = false;
  for (const section of lesson.sections) {
    for (const line of section.lines) {
      if (line.lineId === lineId) {
        if (updates.text) Object.assign(line.text, updates.text);
        if (updates.tokens) line.tokens = updates.tokens;
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return null;

  await putSong(env, songId, lesson);
  return lesson;
}

/**
 * Get job key for R2 storage
 */
function getJobKey(jobId: string): string {
  return `jobs/${jobId}.json`;
}

/**
 * Read a job status from R2
 */
export async function getJob(env: Env, jobId: string): Promise<JobStatus | null> {
  try {
    const object = await env.BUCKET.get(getJobKey(jobId));
    if (!object) return null;
    return JSON.parse(await object.text()) as JobStatus;
  } catch {
    return null;
  }
}

/**
 * Write a job status to R2
 */
export async function putJob(env: Env, job: JobStatus): Promise<void> {
  const json = JSON.stringify(job);
  await env.BUCKET.put(getJobKey(job.jobId), json, {
    httpMetadata: { contentType: 'application/json' },
  });
}

/**
 * Insert a new instrumental line immediately before the specified lineId.
 * Returns the updated lesson, or null if the song/line was not found.
 */
export async function insertInstrumentalBefore(
  env: Env,
  songId: string,
  beforeLineId: string
): Promise<import('./types').LyricLesson | null> {
  const lesson = await getSong(env, songId);
  if (!lesson) return null;

  let inserted = false;
  for (const section of lesson.sections) {
    const idx = section.lines.findIndex((l) => l.lineId === beforeLineId);
    if (idx === -1) continue;

    const newLine: import('./types').LyricLine = {
      lineId: `instrumental-${crypto.randomUUID().slice(0, 8)}`,
      order: 0,
      isInstrumental: true,
      text: { target: '', roman: '', wordByWord: '', direct: '', natural: '' },
      tokens: [],
    };
    section.lines.splice(idx, 0, newLine);

    // Re-number orders within this section
    section.lines.forEach((l, i) => { l.order = i + 1; });
    inserted = true;
    break;
  }

  if (!inserted) return null;
  await putSong(env, songId, lesson);
  return lesson;
}

/**
 * Delete a single line from a stored song. Returns the updated lesson, or null if not found.
 */
export async function deleteLineFromSong(
  env: Env,
  songId: string,
  lineId: string
): Promise<import('./types').LyricLesson | null> {
  const lesson = await getSong(env, songId);
  if (!lesson) return null;

  for (const section of lesson.sections) {
    const idx = section.lines.findIndex((l) => l.lineId === lineId);
    if (idx === -1) continue;
    section.lines.splice(idx, 1);
    section.lines.forEach((l, i) => { l.order = i + 1; });
    await putSong(env, songId, lesson);
    return lesson;
  }
  return null;
}

/**
 * Delete a song and its metadata from R2
 */
export async function deleteSong(
  env: Env,
  songId: string
): Promise<void> {
  try {
    // Delete both the song data and metadata
    await Promise.all([
      env.BUCKET.delete(getSongKey(songId)),
      env.BUCKET.delete(getMetaKey(songId)),
    ]);
  } catch (error) {
    console.error('Error deleting song from R2:', error);
    throw error;
  }
}

// ── Per-User Pending Jobs ────────────────────────────────────────────────────

function getUserPendingJobsKey(userId: string): string {
  return `users/${userId}/pending-jobs.json`;
}

export async function getUserPendingJobIds(env: Env, userId: string): Promise<string[]> {
  try {
    const obj = await env.BUCKET.get(getUserPendingJobsKey(userId));
    if (!obj) return [];
    return JSON.parse(await obj.text()) as string[];
  } catch {
    return [];
  }
}

export async function addUserPendingJob(env: Env, userId: string, jobId: string): Promise<void> {
  const jobs = await getUserPendingJobIds(env, userId);
  if (jobs.includes(jobId)) return;
  jobs.unshift(jobId);
  await env.BUCKET.put(getUserPendingJobsKey(userId), JSON.stringify(jobs), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function removeUserPendingJob(env: Env, userId: string, jobId: string): Promise<void> {
  const jobs = await getUserPendingJobIds(env, userId);
  const filtered = jobs.filter((id) => id !== jobId);
  if (filtered.length === jobs.length) return;
  await env.BUCKET.put(getUserPendingJobsKey(userId), JSON.stringify(filtered), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// ── Per-User Song Lists ──────────────────────────────────────────────────────

function getUserSongsKey(userId: string): string {
  return `users/${userId}/songs.json`;
}

export async function getUserSongs(env: Env, userId: string): Promise<string[]> {
  try {
    const obj = await env.BUCKET.get(getUserSongsKey(userId));
    if (!obj) return [];
    return JSON.parse(await obj.text()) as string[];
  } catch {
    return [];
  }
}

export async function addSongToUser(env: Env, userId: string, songId: string): Promise<void> {
  const songs = await getUserSongs(env, userId);
  if (songs.includes(songId)) return;
  songs.unshift(songId); // newest first
  await env.BUCKET.put(getUserSongsKey(userId), JSON.stringify(songs), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function removeSongFromUser(env: Env, userId: string, songId: string): Promise<void> {
  const songs = await getUserSongs(env, userId);
  const filtered = songs.filter((id) => id !== songId);
  if (filtered.length === songs.length) return;
  await env.BUCKET.put(getUserSongsKey(userId), JSON.stringify(filtered), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// ── Per-User Favorites ───────────────────────────────────────────────────────

interface FavoriteLine {
  lineId: string;
  songId: string;
  songTitle: string;
  target: string;
  roman: string;
  natural?: string;
}

function getFavoritesKey(userId: string): string {
  return `users/${userId}/favorites.json`;
}

export async function getUserFavorites(env: Env, userId: string): Promise<FavoriteLine[]> {
  try {
    const obj = await env.BUCKET.get(getFavoritesKey(userId));
    if (!obj) return [];
    return JSON.parse(await obj.text()) as FavoriteLine[];
  } catch {
    return [];
  }
}

export async function addFavorite(env: Env, userId: string, line: FavoriteLine): Promise<void> {
  const favorites = await getUserFavorites(env, userId);
  if (favorites.some((f) => f.lineId === line.lineId && f.songId === line.songId)) return;
  favorites.push(line);
  await env.BUCKET.put(getFavoritesKey(userId), JSON.stringify(favorites), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function removeFavorite(env: Env, userId: string, lineId: string): Promise<void> {
  const favorites = await getUserFavorites(env, userId);
  const filtered = favorites.filter((f) => f.lineId !== lineId);
  if (filtered.length === favorites.length) return;
  await env.BUCKET.put(getFavoritesKey(userId), JSON.stringify(filtered), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// ── Song Cache ──────────────────────────────────────────────────────────────

export async function songCacheKey(title: string, artist: string): Promise<string> {
  const input = `${title.toLowerCase().trim()}|${artist.toLowerCase().trim()}`;
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function lyricsContentKey(normalizedLyrics: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizedLyrics.toLowerCase()));
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getCachedSongId(env: Env, hash: string): Promise<string | null> {
  try {
    const obj = await env.BUCKET.get(`cache/${hash}/meta.json`);
    if (!obj) return null;
    const meta = JSON.parse(await obj.text()) as { songId: string };
    return meta.songId ?? null;
  } catch {
    return null;
  }
}

export async function setCachedSongId(
  env: Env,
  hash: string,
  songId: string,
  title: string,
  artist: string
): Promise<void> {
  const meta = { title, artist, songId, cachedAt: new Date().toISOString() };
  await env.BUCKET.put(`cache/${hash}/meta.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// ── Song Metadata List ───────────────────────────────────────────────────────

/**
 * List all song metadata from R2
 */
export async function listMetas(env: Env): Promise<SongMetadata[]> {
  try {
    const allKeys: string[] = [];
    let cursor: string | undefined = undefined;
    let truncated = true;
    
    // Fetch all pages from R2 list
    while (truncated) {
      const listed = await env.BUCKET.list({ prefix: 'meta/', cursor });
      allKeys.push(...listed.objects.map(obj => obj.key));
      truncated = listed.truncated;
      cursor = listed.truncated ? listed.cursor : undefined;
    }
    
    const metas: SongMetadata[] = [];
    
    // Fetch each metadata object
    for (const key of allKeys) {
      try {
        const object = await env.BUCKET.get(key);
        if (object) {
          const text = await object.text();
          const meta = JSON.parse(text) as SongMetadata;
          metas.push(meta);
        }
      } catch (error) {
        console.error(`Error fetching metadata for ${key}:`, error);
        // Skip this item and continue
      }
    }
    
    return metas;
  } catch (error) {
    console.error('Error listing metadata from R2:', error);
    return [];
  }
}
