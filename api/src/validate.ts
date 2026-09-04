/**
 * Validation utilities for request/response data
 */

import { JsonifyRequest, LyricLesson } from './types';

// Configuration
const MAX_RAW_LYRICS_LENGTH = 30000;

/**
 * Validation error class
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public code: string = 'VALIDATION_ERROR',
    public details?: any
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Normalize raw lyrics text
 * - Split by newlines
 * - Trim each line
 * - Remove fully empty lines
 */
export function normalizeLyrics(rawLyrics: string): string {
  return rawLyrics
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
}

/**
 * Validate JsonifyRequest
 */
export function validateJsonifyRequest(data: any): JsonifyRequest {
  // Check rawLyrics exists
  if (!data.rawLyrics || typeof data.rawLyrics !== 'string') {
    throw new ValidationError(
      'rawLyrics is required and must be a string',
      'INVALID_REQUEST',
      { field: 'rawLyrics' }
    );
  }

  // Trim and check length
  const rawLyrics = data.rawLyrics.trim();
  
  if (rawLyrics.length === 0) {
    throw new ValidationError(
      'rawLyrics cannot be empty',
      'INVALID_REQUEST',
      { field: 'rawLyrics' }
    );
  }

  if (rawLyrics.length > MAX_RAW_LYRICS_LENGTH) {
    throw new ValidationError(
      `rawLyrics exceeds maximum length of ${MAX_RAW_LYRICS_LENGTH} characters`,
      'INVALID_REQUEST',
      { field: 'rawLyrics', maxLength: MAX_RAW_LYRICS_LENGTH }
    );
  }

  // Normalize and check for actual content
  const normalized = normalizeLyrics(rawLyrics);
  if (normalized.length === 0) {
    throw new ValidationError(
      'rawLyrics contains only whitespace',
      'INVALID_REQUEST',
      { field: 'rawLyrics' }
    );
  }

  // Validate optional fields
  const titleHint = data.titleHint && typeof data.titleHint === 'string' 
    ? data.titleHint.trim() 
    : undefined;
  
  const artistHint = data.artistHint && typeof data.artistHint === 'string' 
    ? data.artistHint.trim() 
    : undefined;

  // Validate language if provided
  let language = data.language;
  if (language) {
    if (typeof language !== 'object' || !language.target || !language.learner) {
      throw new ValidationError(
        'language must have target and learner fields',
        'INVALID_REQUEST',
        { field: 'language' }
      );
    }
    
    if (typeof language.target !== 'string' || typeof language.learner !== 'string') {
      throw new ValidationError(
        'language.target and language.learner must be strings',
        'INVALID_REQUEST',
        { field: 'language' }
      );
    }
  } else {
    // Default to Hindi -> English
    language = { target: 'hi', learner: 'en' };
  }

  return {
    rawLyrics,
    titleHint,
    artistHint,
    language,
  };
}

/**
 * Validate LyricLesson output from OpenAI
 */
export function validateLyricLesson(data: any): LyricLesson {
  // Check required top-level fields
  if (!data.schemaVersion || typeof data.schemaVersion !== 'string') {
    throw new ValidationError(
      'Invalid LyricLesson: missing or invalid schemaVersion',
      'BAD_MODEL_OUTPUT',
      { field: 'schemaVersion' }
    );
  }

  if (!data.lessonId || typeof data.lessonId !== 'string') {
    throw new ValidationError(
      'Invalid LyricLesson: missing or invalid lessonId',
      'BAD_MODEL_OUTPUT',
      { field: 'lessonId' }
    );
  }

  // Check language structure
  if (!data.language || typeof data.language !== 'object') {
    throw new ValidationError(
      'Invalid LyricLesson: missing or invalid language',
      'BAD_MODEL_OUTPUT',
      { field: 'language' }
    );
  }

  if (!data.language.target || !data.language.target.iso || !data.language.target.script) {
    throw new ValidationError(
      'Invalid LyricLesson: missing or invalid language.target',
      'BAD_MODEL_OUTPUT',
      { field: 'language.target' }
    );
  }

  if (!data.language.learner || !data.language.learner.iso) {
    throw new ValidationError(
      'Invalid LyricLesson: missing or invalid language.learner',
      'BAD_MODEL_OUTPUT',
      { field: 'language.learner' }
    );
  }

  // Check sections
  if (!Array.isArray(data.sections) || data.sections.length === 0) {
    throw new ValidationError(
      'Invalid LyricLesson: sections must be a non-empty array',
      'BAD_MODEL_OUTPUT',
      { field: 'sections' }
    );
  }

  // Validate each section has required fields
  data.sections.forEach((section: any, idx: number) => {
    if (!section.sectionId || !section.label || typeof section.order !== 'number') {
      throw new ValidationError(
        `Invalid section at index ${idx}: missing required fields`,
        'BAD_MODEL_OUTPUT',
        { field: `sections[${idx}]` }
      );
    }

    if (!Array.isArray(section.lines)) {
      throw new ValidationError(
        `Invalid section at index ${idx}: lines must be an array`,
        'BAD_MODEL_OUTPUT',
        { field: `sections[${idx}].lines` }
      );
    }

    // Validate each line
    section.lines.forEach((line: any, lineIdx: number) => {
      if (!line.lineId || typeof line.order !== 'number') {
        throw new ValidationError(
          `Invalid line at section ${idx}, line ${lineIdx}`,
          'BAD_MODEL_OUTPUT',
          { field: `sections[${idx}].lines[${lineIdx}]` }
        );
      }

      if (!line.text || !line.text.target || !line.text.roman) {
        throw new ValidationError(
          `Invalid line.text at section ${idx}, line ${lineIdx}`,
          'BAD_MODEL_OUTPUT',
          { field: `sections[${idx}].lines[${lineIdx}].text` }
        );
      }

      if (!Array.isArray(line.tokens)) {
        throw new ValidationError(
          `Invalid line.tokens at section ${idx}, line ${lineIdx}`,
          'BAD_MODEL_OUTPUT',
          { field: `sections[${idx}].lines[${lineIdx}].tokens` }
        );
      }

      // Filter out malformed tokens rather than aborting the whole song.
      // A single bad token should not invalidate a 50-line lesson.
      line.tokens = line.tokens.filter((token: any, tokenIdx: number) => {
        if (!token || typeof token !== 'object') {
          console.warn(`Dropping malformed token at line ${line.lineId} index ${tokenIdx}: not an object`);
          return false;
        }
        if (!token.id || typeof token.id !== 'string') {
          console.warn(`Dropping token at line ${line.lineId} index ${tokenIdx}: missing id`);
          return false;
        }
        if (!token.surface || typeof token.surface !== 'string') {
          console.warn(`Dropping token at line ${line.lineId} index ${tokenIdx}: missing surface`);
          return false;
        }
        if (!token.roman || typeof token.roman !== 'string') {
          console.warn(`Dropping token at line ${line.lineId} index ${tokenIdx}: missing roman`);
          return false;
        }
        if (!token.gloss || typeof token.gloss !== 'string') {
          console.warn(`Dropping token at line ${line.lineId} index ${tokenIdx}: missing gloss`);
          return false;
        }
        return true;
      });
    });
  });

  return data as LyricLesson;
}

/**
 * Type guard for checking if error is ValidationError
 */
export function isValidationError(error: any): error is ValidationError {
  return error instanceof ValidationError;
}
