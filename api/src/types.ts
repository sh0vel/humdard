/**
 * TypeScript type definitions for the Lyric Learning API
 */

// ============================================================================
// Environment Bindings
// ============================================================================

export interface Env {
  BUCKET: R2Bucket;
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  ALLOWED_ORIGINS?: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface JsonifyRequest {
  rawLyrics: string;
  titleHint?: string;
  artistHint?: string;
  language?: {
    target: string;
    learner: string;
  };
}

export interface JsonifyResponse {
  songId: string;
  songMeta: SongMetadata;
}

export interface SongsListResponse {
  songs: SongMetadata[];
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: any;
  };
}

// ============================================================================
// Storage Types
// ============================================================================

export interface SongMetadata {
  songId: string;
  title: string;
  artist?: string;
  createdAt: string;
  updatedAt: string;
  language: {
    target: string;
    learner: string;
  };
  openaiUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUSD: number;
  };
}

// ============================================================================
// LyricLesson Schema
// ============================================================================

export interface LyricLesson {
  schemaVersion: string;
  lessonId: string;
  title: string;
  language: {
    target: {
      iso: string;
      script: string;
    };
    learner: {
      iso: string;
    };
  };
  source: {
    artist?: string;
  };
  sections: LyricSection[];
}

export interface LyricSection {
  sectionId: string;
  label: string;
  order: number;
  lines: LyricLine[];
}

export interface LyricLine {
  lineId: string;
  order: number;
  text: {
    target: string;
    roman: string;
    wordByWord: string;
    direct: string;
    natural: string;
  };
  tokens: LyricToken[];
}

export interface LyricToken {
  id: string;
  surface: string;
  roman: string;
  gloss: string;
}

// ============================================================================
// OpenAI Types
// ============================================================================

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  response_format: {
    type: string;
    json_schema: {
      name: string;
      strict: boolean;
      schema: any;
    };
  };
  temperature?: number;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
      refusal?: string | null;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
