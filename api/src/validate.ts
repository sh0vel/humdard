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

  if (!data.title || typeof data.title !== 'string') {
    throw new ValidationError(
      'Invalid LyricLesson: missing or invalid title',
      'BAD_MODEL_OUTPUT',
      { field: 'title' }
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

  // Check source
  if (!data.source || typeof data.source !== 'object') {
    throw new ValidationError(
      'Invalid LyricLesson: missing or invalid source',
      'BAD_MODEL_OUTPUT',
      { field: 'source' }
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

      if (!line.text || !line.text.target || !line.text.roman || !line.text.wordByWord || !line.text.direct || !line.text.natural) {
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

      // Validate each token
      line.tokens.forEach((token: any, tokenIdx: number) => {
        if (!token || typeof token !== 'object') {
          throw new ValidationError(
            `Invalid token at line ${line.lineId}, token index ${tokenIdx}`,
            'BAD_MODEL_OUTPUT',
            { field: `sections[${idx}].lines[${lineIdx}].tokens[${tokenIdx}]` }
          );
        }

        if (!token.id || typeof token.id !== 'string') {
          throw new ValidationError(
            `Invalid token.id at line ${line.lineId}, token index ${tokenIdx}`,
            'BAD_MODEL_OUTPUT',
            { field: `sections[${idx}].lines[${lineIdx}].tokens[${tokenIdx}].id` }
          );
        }

        if (!token.surface || typeof token.surface !== 'string') {
          throw new ValidationError(
            `Invalid token.surface at line ${line.lineId}, token index ${tokenIdx}`,
            'BAD_MODEL_OUTPUT',
            { field: `sections[${idx}].lines[${lineIdx}].tokens[${tokenIdx}].surface` }
          );
        }

        if (!token.roman || typeof token.roman !== 'string') {
          throw new ValidationError(
            `Invalid token.roman at line ${line.lineId}, token index ${tokenIdx}`,
            'BAD_MODEL_OUTPUT',
            { field: `sections[${idx}].lines[${lineIdx}].tokens[${tokenIdx}].roman` }
          );
        }

        if (!token.gloss || typeof token.gloss !== 'string') {
          throw new ValidationError(
            `Invalid token.gloss at line ${line.lineId}, token index ${tokenIdx}`,
            'BAD_MODEL_OUTPUT',
            { field: `sections[${idx}].lines[${lineIdx}].tokens[${tokenIdx}].gloss` }
          );
        }
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
