# Humdard Lyric Learning API

Production-ready Cloudflare Worker API for converting raw song lyrics (Hindi/Devanagari) into structured JSON format for language learning.

## Features

- ✅ Convert raw lyrics to structured LyricLesson JSON using OpenAI
- ✅ Store lessons in Cloudflare R2
- ✅ List and retrieve songs via REST API
- ✅ CORS support for browser clients
- ✅ Input validation and error handling
- ✅ Deterministic song IDs
- ✅ Server-side OpenAI integration (never exposed to browser)

## Tech Stack

- **Runtime**: Cloudflare Workers (TypeScript, modules syntax)
- **Storage**: Cloudflare R2
- **AI**: OpenAI API with structured outputs
- **Validation**: Runtime type checking

## API Endpoints

### 1. `GET /api/songs`
List all songs with metadata.

**Response:**
```json
{
  "songs": [
    {
      "songId": "hamdard-8f3a1c2d",
      "title": "Hamdard",
      "artist": "Arijit Singh",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z",
      "language": {
        "target": "hi",
        "learner": "en"
      }
    }
  ]
}
```

**Headers:**
- `Cache-Control: public, max-age=60`
- `ETag: "..."` (SHA-256 hash of response body for cache validation)

**Caching:**
Supports conditional requests with `If-None-Match` header. If the ETag matches, returns 304 Not Modified with no body.

### 2. `GET /api/songs/:songId`
Get a specific song's full LyricLesson JSON.

**Response:**
Returns the complete LyricLesson object (see schema below).

**Error (404):**
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Song not found"
  }
}
```

### 3. `POST /api/jsonify`
Convert raw lyrics to structured format.

**Request:**
```json
{
  "rawLyrics": "हमदर्द है ये...\n...",
  "titleHint": "Hamdard",
  "artistHint": "Arijit Singh",
  "language": {
    "target": "hi",
    "learner": "en"
  }
}
```

**Fields:**
- `rawLyrics` (required): Raw lyrics text (max 30,000 chars)
- `titleHint` (optional): Song title hint
- `artistHint` (optional): Artist name hint
- `language` (optional): Target/learner language pair (defaults to `hi`/`en`)

**Response (201):**
```json
{
  "songId": "hamdard-8f3a1c2d",
  "songMeta": {
    "songId": "hamdard-8f3a1c2d",
    "title": "Hamdard",
    "artist": "Arijit Singh",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z",
    "language": {
      "target": "hi",
      "learner": "en"
    }
  }
}
```

## LyricLesson Schema

```typescript
interface LyricLesson {
  schemaVersion: "1.0.0";
  lessonId: string;
  title: string;
  language: {
    target: { iso: "hi"; script: "Deva" };
    learner: { iso: "en" };
  };
  source: {
    artist?: string;
  };
  sections: [
    {
      sectionId: "main";
      label: "Main";
      order: 1;
      lines: [
        {
          lineId: "l001";
          order: 1;
          text: {
            target: "हमदर्द है ये";
            roman: "hamdard hai ye";
            wordByWord: "companion is this";
            direct: "companion is this";
            natural: "This is a companion";
          };
          tokens: [
            {
              id: "t001";
              surface: "हमदर्द";
              roman: "hamdard";
              gloss: "companion/sympathizer";
            }
            // ...
          ];
        }
        // ...
      ];
    }
  ];
}
```

## Setup Instructions

### Prerequisites
- Node.js 18+ and npm
- Cloudflare account
- OpenAI API key

### 1. Install Dependencies
```bash
npm install
```

### 2. Create R2 Bucket
```bash
wrangler r2 bucket create lyric-lessons
```

### 3. Set OpenAI API Key
```bash
wrangler secret put OPENAI_API_KEY
# When prompted, paste your OpenAI API key
```

### 4. Configure Environment (Optional)
Edit `wrangler.toml` to customize:
- `ALLOWED_ORIGINS`: Comma-separated allowed origins (or `*` for dev)
- `OPENAI_MODEL`: OpenAI model name (default: `gpt-4o-2024-08-06`)

### 5. Development
```bash
npm run dev
```

The worker will be available at `http://localhost:8787`

### 6. Deploy
```bash
npm run deploy
```

Your API will be live at `https://humdard-lyric-api.<your-subdomain>.workers.dev`

## Storage Layout in R2

```
lyric-lessons/
├── songs/
│   ├── hamdard-8f3a1c2d.json
│   ├── tum-hi-ho-a1b2c3d4.json
│   └── ...
└── meta/
    ├── hamdard-8f3a1c2d.json
    ├── tum-hi-ho-a1b2c3d4.json
    └── ...
```

**`songs/{songId}.json`**: Full LyricLesson JSON  
**`meta/{songId}.json`**: Song metadata for listing

**Metadata Format:**
```json
{
  "songId": "hamdard-8f3a1c2d",
  "title": "Hamdard",
  "artist": "Arijit Singh",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z",
  "language": {
    "target": "hi",
    "learner": "en"
  }
}
```

The API lists songs by reading all `meta/*.json` files from R2, then sorting by `updatedAt` (descending).

## Example Usage

### List Songs
```bash
curl https://humdard-lyric-api.yourname.workers.dev/api/songs
```

### Get Song
```bash
curl https://humdard-lyric-api.yourname.workers.dev/api/songs/hamdard-8f3a1c2d
```

### Create Lesson
```bash
curl -X POST https://humdard-lyric-api.yourname.workers.dev/api/jsonify \
  -H "Content-Type: application/json" \
  -d '{
    "rawLyrics": "हमदर्द है ये\nबेवफा नहीं है",
    "titleHint": "Hamdard",
    "artistHint": "Arijit Singh"
  }'
```

## Error Handling

All errors return JSON with consistent format:
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "details": { /* optional additional info */ }
  }
}
```

**Common Error Codes:**
- `VALIDATION_ERROR`: Invalid request data
- `NOT_FOUND`: Resource not found
- `AI_GENERATION_ERROR`: OpenAI API failure
- `BAD_MODEL_OUTPUT`: OpenAI returned invalid structure
- `STORAGE_ERROR`: R2 operation failed
- `INTERNAL_ERROR`: Unexpected server error

## Security

- **Rate Limiting**: TODO - Add per-IP rate limiting for production
- **Input Validation**: Max 30,000 chars for rawLyrics
- **CORS**: Configurable allowed origins
- **API Key**: OpenAI key stored as Worker secret (never exposed)

## Development Notes

### Song ID Generation
- Format: `{slug}-{hash}`
- Slug: Normalized title (lowercase, hyphens)
- Hash: First 8 chars of SHA-256 hash of rawLyrics
- Example: `hamdard-8f3a1c2d`

### Lyrics Normalization
1. Split by newlines
2. Trim each line
3. Remove empty lines
4. Join with newlines

### Caching
- Song list (`GET /api/songs`):
  - `Cache-Control: public, max-age=60`
  - ETag based on SHA-256 hash of response body
  - Supports `If-None-Match` for 304 Not Modified responses
- Individual songs are immutable (can be cached indefinitely)

### Lyric Line Schema
Each lyric line now includes five translation outputs:
1. **target**: Original Hindi/Devanagari text
2. **roman**: Romanization/transliteration
3. **wordByWord**: Word-by-word ordered translation (new)
4. **direct**: Literal translation
5. **natural**: Contextual/idiomatic translation

### Storage Architecture
- **No central index file**: Removed `index/index.json` to avoid race conditions
- **Per-song metadata**: Each song has metadata at `meta/{songId}.json`
- **Listing**: `GET /api/songs` reads all `meta/*.json` files and sorts by `updatedAt`
- **Atomic operations**: Song creation writes both `songs/{songId}.json` and `meta/{songId}.json`

## Project Structure

```
api/
├── src/
│   ├── index.ts      # Main router & handlers
│   ├── types.ts      # TypeScript types
│   ├── cors.ts       # CORS utilities
│   ├── storage.ts    # R2 operations
│   ├── openai.ts     # OpenAI integration
│   ├── validate.ts   # Input/output validation
│   └── utils.ts      # Helper functions
├── wrangler.toml     # Cloudflare config
├── tsconfig.json     # TypeScript config
├── package.json      # Dependencies
└── README.md         # This file
```

## License

MIT

## Support

For issues or questions, please open an issue on the repository.
