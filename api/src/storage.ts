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
