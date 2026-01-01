/**
 * Utility functions for ID generation and text processing
 */

/**
 * Generate a slug from text
 * Converts to lowercase, removes special chars, replaces spaces with hyphens
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .normalize('NFD') // Decompose combined characters
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^\w\s-]/g, '') // Remove non-word chars except spaces and hyphens
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Generate SHA-256 hash and return first 8 hex characters
 */
export async function generateHash(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 8);
}

/**
 * Generate full SHA-256 hash as hex string
 */
export async function generateFullHash(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a deterministic song ID from title and raw lyrics
 */
export async function generateSongId(title: string, rawLyrics: string): Promise<string> {
  const slug = slugify(title || 'untitled');
  const hash = await generateHash(rawLyrics);
  
  // Ensure slug is not empty
  const finalSlug = slug || 'untitled';
  
  return `${finalSlug}-${hash}`;
}
