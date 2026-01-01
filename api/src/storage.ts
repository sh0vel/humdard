/**
 * R2 storage operations for song data and metadata management
 */

import { Env, LyricLesson, SongMetadata } from './types';

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
