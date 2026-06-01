/**
 * OpenAI API integration for structured lyric processing.
 *
 * Generation uses two phases:
 *   Phase 1 (base call)  — structure, native script, roman, wordByWord, tokens
 *   Phase 2 (parallel)   — direct | natural translations run concurrently
 */

import { Env, LyricLesson, OpenAIRequest, OpenAIResponse } from './types';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-5.5';

// ============================================================================
// Schemas
// ============================================================================

const BASE_LESSON_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string' },
    lessonId: { type: 'string' },
    title: { type: 'string' },
    language: {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: { iso: { type: 'string' }, script: { type: 'string' } },
          required: ['iso', 'script'],
          additionalProperties: false,
        },
        learner: {
          type: 'object',
          properties: { iso: { type: 'string' } },
          required: ['iso'],
          additionalProperties: false,
        },
      },
      required: ['target', 'learner'],
      additionalProperties: false,
    },
    source: {
      type: 'object',
      properties: { artist: { type: 'string' } },
      required: ['artist'],
      additionalProperties: false,
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sectionId: { type: 'string' },
          label: { type: 'string' },
          order: { type: 'number' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                lineId: { type: 'string' },
                order: { type: 'number' },
                text: {
                  type: 'object',
                  properties: {
                    target: { type: 'string' },
                    roman: { type: 'string' },
                  },
                  required: ['target', 'roman'],
                  additionalProperties: false,
                },
              },
              required: ['lineId', 'order', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['sectionId', 'label', 'order', 'lines'],
        additionalProperties: false,
      },
    },
  },
  required: ['schemaVersion', 'lessonId', 'title', 'language', 'source', 'sections'],
  additionalProperties: false,
};

const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lineId: { type: 'string' },
          translation: { type: 'string' },
        },
        required: ['lineId', 'translation'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

const TOKEN_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lineId: { type: 'string' },
          tokens: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id:          { type: 'string' },
                surface:     { type: 'string' },
                roman:       { type: 'string' },
                gloss:       { type: 'string' },
                definition:  { type: 'string' },
                spectrum:    { type: 'string' },
                songContext: { type: 'string' },
              },
              required: ['id', 'surface', 'roman', 'gloss', 'definition', 'spectrum', 'songContext'],
              additionalProperties: false,
            },
          },
        },
        required: ['lineId', 'tokens'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

// ============================================================================
// System prompts
// ============================================================================

// Programmatic lookup used for post-processing normalization.
// Key: native script surface (exact match). Value: canonical roman spelling.
// Entries with anusvara variants (आँ/आं) are listed separately so both match.
const ROMAN_LOOKUP: Record<string, string> = {
  // Pronouns / subject markers
  'मैं': 'main',   'में': 'mein',   'मे': 'mein',
  'है': 'hai',     'हैं': 'hain',   'हूँ': 'hoon',   'हूं': 'hoon',
  'हो': 'ho',      'था': 'tha',     'थी': 'thi',     'थे': 'the',
  'हुआ': 'hua',   'हुई': 'hui',    'हुए': 'hue',
  'तुम': 'tum',   'आप': 'aap',     'हम': 'hum',
  'मुझे': 'mujhe','तुझे': 'tujhe', 'उसे': 'use',
  'हमें': 'hamein','तुम्हें': 'tumhein',
  'मेरा': 'mera', 'मेरी': 'meri',  'मेरे': 'mere',
  'तेरा': 'tera', 'तेरी': 'teri',  'तेरे': 'tere',
  'हमारा': 'hamara','हमारी': 'hamari',
  'उसका': 'uska', 'उसकी': 'uski',  'उसके': 'uske',
  'इसका': 'iska', 'इसकी': 'iski',
  // Demonstratives / interrogatives
  'यह': 'yeh',    'ये': 'ye',
  'वह': 'woh',    'वो': 'woh',
  'यहाँ': 'yahan','यहां': 'yahan',
  'वहाँ': 'wahan','वहां': 'wahan',
  'क्या': 'kya',  'क्यों': 'kyun', 'कैसे': 'kaise','कहाँ': 'kahan','कहां': 'kahan',
  'कब': 'kab',    'कौन': 'kaun',   'कितना': 'kitna',
  // Negation / particles
  'नहीं': 'nahin','न': 'na',       'मत': 'mat',
  'हाँ': 'haan',  'हां': 'haan',
  'भी': 'bhi',    'तो': 'to',      'ही': 'hi',
  'और': 'aur',    'पर': 'par',     'जो': 'jo',
  'कोई': 'koi',   'कुछ': 'kuch',  'सब': 'sab',
  'अब': 'ab',     'जब': 'jab',    'तब': 'tab',
  'फिर': 'phir',  'बस': 'bas',    'कभी': 'kabhi',
  'हमेशा': 'hamesha','शायद': 'shayad','लेकिन': 'lekin','मगर': 'magar',
  // Emotional / lyrical vocabulary
  'दिल': 'dil',
  'प्यार': 'pyaar',
  'इश्क़': 'ishq', 'इश्क': 'ishq',
  'मोहब्बत': 'mohabbat',
  'ज़िंदगी': 'zindagi','जिंदगी': 'zindagi',
  'ख़ुशी': 'khushi','खुशी': 'khushi',
  'ग़म': 'gham',  'गम': 'gham',
  'याद': 'yaad',  'बात': 'baat',  'साथ': 'saath', 'रात': 'raat',
  'वक़्त': 'waqt','वक्त': 'waqt',
  'ख़्वाब': 'khwab','ख्वाब': 'khwab',
  'आवाज़': 'awaaz','आवाज': 'awaaz',
  'दुनिया': 'duniya','रास्ता': 'raasta',
  'मंज़िल': 'manzil','मंजिल': 'manzil',
  'सफ़र': 'safar','सफर': 'safar',
  'ख़ुदा': 'khuda','खुदा': 'khuda',
  'ख़्वाहिश': 'khwahish','ख्वाहिश': 'khwahish',
  'आँख': 'aankh','आंख': 'aankh',
  'आँसू': 'aansu','आंसू': 'aansu',
  'ख़याल': 'khayal','खयाल': 'khayal',
  'ख़ुद': 'khud','खुद': 'khud',
  'जान': 'jaan', 'दर्द': 'dard',
  'उम्मीद': 'ummeed','उमीद': 'ummeed',
  'इंतज़ार': 'intezaar','इंतजार': 'intezaar',
  'एहसास': 'ehsaas','अहसास': 'ehsaas',
  'खुशबू': 'khushbu','ख़ुशबू': 'khushbu',
  'रूह': 'rooh',
  // Common verbs (root forms)
  'आना': 'aana',  'जाना': 'jaana','होना': 'hona', 'करना': 'karna',
  'देखना': 'dekhna','सुनना': 'sunna','मिलना': 'milna',
  'रहना': 'rehna','चलना': 'chalna','बोलना': 'bolna',
  'समझना': 'samajhna','सोचना': 'sochna','छोड़ना': 'chhodna',
};

// After generation, walk every token and normalise its roman against ROMAN_LOOKUP.
// Any token that changes also patches the parent line's roman string via whole-word
// replacement so the main lyrics display stays in sync.
function normalizeRomanization(lesson: { sections: Array<{ lines: Array<{ text: { roman: string }; tokens: Array<{ surface: string; roman: string }> }> }> }): void {
  for (const section of lesson.sections) {
    for (const line of section.lines) {
      const replacements: Array<{ from: string; to: string }> = [];

      for (const token of line.tokens) {
        const canonical = ROMAN_LOOKUP[token.surface];
        if (canonical && canonical !== token.roman) {
          replacements.push({ from: token.roman, to: canonical });
          token.roman = canonical;
        }
      }

      if (replacements.length === 0) continue;

      let lineRoman = line.text.roman;
      for (const { from, to } of replacements) {
        if (!from) continue;
        const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        lineRoman = lineRoman.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), to);
      }
      line.text.roman = lineRoman;
    }
  }
}

const ROMANIZATION_TABLE = `ROMANIZATION CANONICAL TABLE — use EXACTLY these spellings, never deviate:
मैं (I)        → main        में (in/inside)  → mein        है            → hai          हैं           → hain
नहीं           → nahin       हाँ              → haan        भी            → bhi          तो            → to
और             → aur         पर               → par         जो            → jo           कोई           → koi
यह             → yeh         वह/वो            → woh         यहाँ          → yahan        वहाँ          → wahan
क्या           → kya         तुम              → tum         मुझे          → mujhe        तुझे          → tujhe
हमें           → hamein      तुम्हें          → tumhein     मेरा/मेरी/मेरे → mera/meri/mere
तेरा/तेरी/तेरे → tera/teri/tere               हमारा/हमारी  → hamara/hamari
दिल            → dil         प्यार            → pyaar       इश्क़          → ishq         मोहब्बत      → mohabbat
ज़िंदगी        → zindagi     ख़ुशी            → khushi      ग़म            → gham         याद           → yaad
बात            → baat        साथ              → saath       रात            → raat         वक़्त         → waqt
ख़्वाब         → khwab       आवाज़            → awaaz       दुनिया         → duniya       रास्ता        → raasta
मंज़िल         → manzil      सफ़र             → safar       ख़ुदा          → khuda        ख़्वाहिश      → khwahish
हो             → ho          हूँ              → hoon        था/थी/थे      → tha/thi/the  हुआ/हुई      → hua/hui
आना            → aana        जाना             → jaana       होना           → hona         करना          → karna
लेकिन          → lekin       मगर              → magar       अब             → ab           जब            → jab
आँख            → aankh       आँसू             → aansu       ख़याल          → khayal       ख़ुद           → khud
कुछ            → kuch        कभी              → kabhi       सब             → sab          हमेशा         → hamesha`;

const BASE_SYSTEM_PROMPT = `You are an expert language-learning content creator for South Asian songs.

AUTO-DETECT the primary language from the lyrics and output in the correct NATIVE SCRIPT:
- Hindi (Bollywood, Hindustani, Hindi-leaning vocabulary) → Devanagari, iso: "hi", script: "Devanagari"
- Urdu (Pakistani music, ghazal tradition, heavy Persian/Arabic loanwords) → Arabic/Nastaliq, iso: "ur", script: "Arabic"
- Bangla/Bengali → Bengali script, iso: "bn", script: "Bengali"
- Ambiguous Hindustani → default to Devanagari (Hindi)

${ROMANIZATION_TABLE}

For EVERY lyric line produce:

1. target — the line in the CORRECT NATIVE SCRIPT
   - If input is Roman: convert to the detected native script
   - If input is already native script: copy exactly (preserve nukta, punctuation)
   - NEVER copy Roman text into the target field

2. roman — consistent beginner-friendly Latin transliteration, NO diacritics (no ā ī ū ṇ etc.)
   - MUST follow the canonical table above for every word that appears in it
   - Apply the same canonical spelling consistently across every line of the song

STRUCTURE:
- schemaVersion: "1.0.0"
- Group all lines into one section: sectionId="main", label="Main", order=1
- lineId format: "l001", "l002", ...

CRITICAL RULES:
- Exactly one output line per input lyric line — do NOT merge or split
- Remove section labels ([Verse 1], [Chorus], etc.) and credits — process only lyric lines
- Keep original line order
- Romanization must be consistent across the whole song — same word, same spelling, every time
- Return ONLY the JSON matching the schema`;

const TOKEN_SYSTEM_PROMPT = `You are an expert South Asian linguistics educator creating per-word breakdowns for song lyrics.

You are given all lines of a song (lineId | native script | romanization | word-by-word gloss).
Produce a tokens array for EVERY line.

${ROMANIZATION_TABLE}

For each token produce SIX fields:
- id: "t001", "t002", ... (restart per line)
- surface: exact substring from the native script line
- roman: romanization of that token — follow canonical table, no diacritics
- gloss: short English meaning (1–4 words)
- definition: learner-focused lexical entry. Include part of speech, core meaning (1–2 sentences), a register/origin note only if genuinely useful (e.g. Persian, Sanskrit, Urdu literary), native usage insight explaining how speakers actually use the word especially where it differs from the English gloss, and optionally a short common collocation. Teach the word as a living part of the language — prioritize nuance, semantic range, and what would surprise a learner. 3–6 sentences. Do not reference this song or lyric. Avoid anatomical descriptions, encyclopedic detail, or overly formal language.
- spectrum: Nearby synonyms/alternatives a learner may encounter. Learner-oriented, compact, comparison-based. Short contrast patterns, max 12 words per alternative. Roman script only — no native script characters. Use "" only if no meaningful alternatives exist.
- songContext: Single concise sentence, max 15 words. Explain why THIS word was chosen in this lyric — its tone, imagery, or emotional effect. Do not restate the gloss or spectrum. For grammatical particles (ka, ki, ke, se, ne, ko, bhi, hi, to, na, etc.), give a concise learner-focused grammar note instead.

RULES:
- Every word in the line must have exactly one token (including particles)
- surface must be an exact substring of the native script target
- Return ONLY the JSON matching the schema`;

const TRANSLATION_HIERARCHY = `TRANSLATION HIERARCHY
The translation fields have different purposes and authority levels:
1. wordByWord — preserves token-order structure
2. direct — preserves the actual semantic meaning of the lyric; this is the primary truth-preserving English translation
3. natural — improves fluency and emotional readability; must remain semantically equivalent to direct

If uncertain: preserve ambiguity, stay semantically conservative, avoid interpretation inflation.`;

const FRAGMENT_NOTE = `IMPORTANT:
Many lyric lines are incomplete poetic fragments that continue into neighboring lines.
Use adjacent lines for semantic interpretation.
Do NOT force every individual line into a fully standalone English thought if the original line is fragmentary.
Preserve fragmentary structure when appropriate.`;

function makeDirectPrompt(): string {
  return `You are a precise linguistic translator for South Asian songs.

${TRANSLATION_HIERARCHY}

For each line (lineId | native script | romanization), produce a DIRECT English translation:
- Grammatically correct, literal, plain English
- Textbook-style — neutral and clear, no added imagery or emotion
- Fragments are fine if the original is fragmentary
- For repeated lines: direct MUST be identical across all repeats
- Never leave South Asian words untranslated

${FRAGMENT_NOTE}

Return ONLY the JSON matching the schema.`;
}

function makeNaturalPrompt(): string {
  return `You are a fluent translator for South Asian song lyrics.

${TRANSLATION_HIERARCHY}

For each line (lineId | native script | romanization), produce a NATURAL English translation:
- Smooth, emotionally faithful, conversational — sounds like real English
- NOT overly literal; light paraphrase is fine for fluency
- Must remain semantically equivalent to direct — same meaning, better flow
- For repeated lines: natural MAY vary slightly in phrasing but never in meaning
- May smooth English and clarify implied meaning, but MUST NOT introduce new actors, locations, emotions, intentions, relationships, or imagery that do not exist in the original lyric
- May improve fluency and readability, but must stay as close as possible to the original meaning
- MUST NOT introduce new tense, certainty, emphasis, time references, motivations, or emotional conclusions that are not explicitly present in the lyric
- MUST NOT introduce new tense, certainty, frequency, emphasis, emotional conclusions, or implied facts not explicitly present in the lyric

FIDELITY CONSTRAINTS — BAD/GOOD EXAMPLES:
These are the most common errors. Treat each as a hard rule.

1. No tense shifts — if the original is present tense, stay present tense:
   BAD: "I was standing here" (added past)
   GOOD: "I am standing here"

2. No frequency additions — do not add "never", "always", "ever", "still" unless the original says so:
   BAD: "Where were they, never to return"
   GOOD: "Where did they go"

3. No emphasis additions — do not add "really", "so", "such", "truly", "completely":
   BAD: "You were really there"
   GOOD: "You were there"

4. No invented adjectives — do not add descriptors not in the original:
   BAD: "A strange beauty" (original: "a beauty")
   GOOD: "A beauty"

5. No meaning substitution — translate the actual word, not a poetic synonym:
   BAD: "I was bewitched" (for दीवाना = crazy/devoted)
   GOOD: "I was lost in you" or "I was devoted"
   BAD: "I admit" (for माना = granted / even if so)
   GOOD: "Granted" or "Even so"

6. No new time references — do not add "for a while", "for a moment", "still":
   BAD: "Stay with me for a while" (original: "stay")
   GOOD: "Stay with me"

7. No certainty shifts — do not turn questions or uncertainty into statements:
   BAD: "They were never there" (original asks: "where were they?")
   GOOD: "Where were they"

GRAMMATICAL INDEPENDENCE — CRITICAL:
Each line's translation must read as a grammatically self-contained English lyric line.
You MAY use neighboring lines for emotional interpretation, ambiguity resolution, metaphor understanding, and pronoun reference.
You MUST NOT import English connector words from adjacent lines.
Do NOT begin a translation with subordinating conjunctions (that, because, so that, therefore, since) unless the CURRENT line itself contains that causal or subordinate structure in the original.

BAD (grammatical leakage from adjacent line):
  "That I am enough for you"
  "That I fall apart from your words"
  "Because you never understood"
GOOD (standalone, emotionally faithful):
  "I am enough for you"
  "Your words could make me fall apart"
  "You never understood"

${FRAGMENT_NOTE}

Return ONLY the JSON matching the schema.`;
}


// ============================================================================
// Usage tracking
// ============================================================================

export interface OpenAIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
}

export interface LyricLessonResult {
  lesson: LyricLesson;
  usage: OpenAIUsage;
}

function calculateCost(promptTokens: number, completionTokens: number): number {
  const inputCostPer1M = 2.0;
  const outputCostPer1M = 10.0;
  return (promptTokens / 1_000_000) * inputCostPer1M + (completionTokens / 1_000_000) * outputCostPer1M;
}

// ============================================================================
// Core OpenAI call
// ============================================================================

async function callOpenAI<T>(
  env: Env,
  messages: { role: 'system' | 'user'; content: string }[],
  schema: object,
  schemaName: string,
  modelOverride?: string
): Promise<{ result: T; promptTokens: number; completionTokens: number }> {
  const model = modelOverride ?? env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const body: OpenAIRequest = {
    model,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema },
    },
  };

  const t0 = Date.now();
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  const choice = data.choices?.[0];
  if (!choice) throw new Error('No choices from OpenAI');
  if (choice.message.refusal) throw new Error(`OpenAI refused: ${choice.message.refusal}`);
  if (!choice.message.content) throw new Error('No content from OpenAI');

  const ms = Date.now() - t0;
  console.log(`[openai:${schemaName}] ${ms}ms | prompt=${data.usage?.prompt_tokens ?? 0} completion=${data.usage?.completion_tokens ?? 0}`);

  return {
    result: JSON.parse(choice.message.content) as T,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ============================================================================
// Phase 1: base structural call
// ============================================================================

type BaseLyricLesson = Omit<LyricLesson, 'sections'> & {
  sections: Array<{
    sectionId: string;
    label: string;
    order: number;
    lines: Array<{
      lineId: string;
      order: number;
      text: { target: string; roman: string };
    }>;
  }>;
};

async function generateBase(
  env: Env,
  rawLyrics: string,
  titleHint?: string,
  artistHint?: string,
  lessonId?: string,
  feedback?: string
): Promise<{ base: BaseLyricLesson; promptTokens: number; completionTokens: number }> {
  let userPrompt = 'Parse and structure the following song lyrics.\n\n';
  userPrompt += `Raw Lyrics:\n${rawLyrics}\n\n`;
  if (feedback) userPrompt += `Translator feedback:\n${feedback}\n\n`;
  if (titleHint) userPrompt += `Title hint: ${titleHint}\n`;
  if (artistHint) userPrompt += `Artist hint: ${artistHint}\n`;
  if (lessonId) userPrompt += `Use lessonId: ${lessonId}\n`;
  userPrompt += '\nDetect the language, produce target (native script), roman, and wordByWord for each line.';

  const { result, promptTokens, completionTokens } = await callOpenAI<BaseLyricLesson>(
    env,
    [
      { role: 'system', content: BASE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    BASE_LESSON_SCHEMA,
    'lyric_lesson_base'
  );

  return { base: result, promptTokens, completionTokens };
}

// ============================================================================
// Phase 2: translation calls
// ============================================================================

type TranslationType = 'direct' | 'natural';

interface FlatLine {
  lineId: string;
  target: string;
  roman: string;
}

async function generateTranslations(
  env: Env,
  lines: FlatLine[],
  type: TranslationType,
  titleHint?: string,
  artistHint?: string
): Promise<{ map: Map<string, string>; promptTokens: number; completionTokens: number }> {
  const systemPrompt =
    type === 'direct' ? makeDirectPrompt() : makeNaturalPrompt();

  const lineTable = lines
    .map(l => `${l.lineId} | ${l.target} | ${l.roman}`)
    .join('\n');

  let userPrompt = '';
  if (titleHint || artistHint) {
    userPrompt += `Song: "${titleHint ?? ''}"${artistHint ? ` by ${artistHint}` : ''}\n\n`;
  }
  userPrompt += `Lines (lineId | native script | romanization):\n${lineTable}\n\n`;
  userPrompt += `Produce the ${type} translation for each lineId.`;

  const { result, promptTokens, completionTokens } = await callOpenAI<{ lines: { lineId: string; translation: string }[] }>(
    env,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    TRANSLATION_SCHEMA,
    `translation_${type}`
  );


  const map = new Map<string, string>();
  for (const l of result.lines) map.set(l.lineId, l.translation);
  return { map, promptTokens, completionTokens };
}

// ============================================================================
// Phase 2c: token call
// ============================================================================

async function generateTokens(
  env: Env,
  lines: FlatLine[],
  titleHint?: string,
  artistHint?: string
): Promise<{ map: Map<string, import('./types').LyricToken[]>; promptTokens: number; completionTokens: number }> {
  const lineTable = lines
    .map(l => `${l.lineId} | ${l.target} | ${l.roman}`)
    .join('\n');

  let userPrompt = '';
  if (titleHint || artistHint) {
    userPrompt += `Song: "${titleHint ?? ''}"${artistHint ? ` by ${artistHint}` : ''}\n\n`;
  }
  userPrompt += `Lines (lineId | native script | romanization):\n${lineTable}\n\n`;
  userPrompt += 'Produce tokens for every line.';

  const { result, promptTokens, completionTokens } = await callOpenAI<{ lines: { lineId: string; tokens: import('./types').LyricToken[] }[] }>(
    env,
    [
      { role: 'system', content: TOKEN_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    TOKEN_SCHEMA,
    'tokens',
    'gpt-4o'
  );


  const map = new Map<string, import('./types').LyricToken[]>();
  for (const l of result.lines) map.set(l.lineId, l.tokens);
  return { map, promptTokens, completionTokens };
}

// ============================================================================
// Orchestrator
// ============================================================================

export async function generateLyricLesson(
  env: Env,
  rawLyrics: string,
  titleHint?: string,
  artistHint?: string,
  lessonId?: string,
  _targetLang: string = 'hi',
  _learnerLang: string = 'en',
  feedback?: string
): Promise<LyricLessonResult> {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

  // Phase 1: structure + native script + roman
  const { base, promptTokens: p1, completionTokens: c1 } = await generateBase(
    env, rawLyrics, titleHint, artistHint, lessonId, feedback
  );

  // Flatten lines for Phase 2
  const flatLines: FlatLine[] = base.sections.flatMap(s =>
    s.lines.map(l => ({ lineId: l.lineId, target: l.text.target, roman: l.text.roman }))
  );

  // Phase 2: direct + natural + tokens all in parallel
  const [
    { map: directMap, promptTokens: p2d, completionTokens: c2d },
    { map: naturalMap, promptTokens: p2n, completionTokens: c2n },
    { map: tokenMap,   promptTokens: p2t, completionTokens: c2t },
  ] = await Promise.all([
    generateTranslations(env, flatLines, 'direct', titleHint, artistHint),
    generateTranslations(env, flatLines, 'natural', titleHint, artistHint),
    generateTokens(env, flatLines, titleHint, artistHint),
  ]);

  // Merge everything into the full lesson — derive wordByWord from token glosses
  const lesson: LyricLesson = {
    ...base,
    sections: base.sections.map(section => ({
      ...section,
      lines: section.lines.map(line => {
        const tokens = tokenMap.get(line.lineId) ?? [];
        return {
          ...line,
          text: {
            ...line.text,
            wordByWord: tokens.map(t => t.gloss).join(' '),
            direct:     directMap.get(line.lineId)  ?? '',
            natural:    naturalMap.get(line.lineId) ?? '',
          },
          tokens,
        };
      }),
    })),
  };

  normalizeRomanization(lesson);

  const totalPrompt = p1 + p2d + p2n + p2t;
  const totalCompletion = c1 + c2d + c2n + c2t;
  const estimatedCostUSD = calculateCost(totalPrompt, totalCompletion);

  console.log(`[generateLyricLesson] total ~$${estimatedCostUSD.toFixed(4)}`);

  return {
    lesson,
    usage: {
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      totalTokens: totalPrompt + totalCompletion,
      estimatedCostUSD,
    },
  };
}

// ============================================================================
// Single-line retranslate (keeps one call for low latency on a single line)
// ============================================================================

const LINE_RETRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    roman:      { type: 'string' },
    wordByWord: { type: 'string' },
    direct:     { type: 'string' },
    natural:    { type: 'string' },
    tokens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:          { type: 'string' },
          surface:     { type: 'string' },
          roman:       { type: 'string' },
          gloss:       { type: 'string' },
          definition:  { type: 'string' },
          spectrum:    { type: 'string' },
          songContext: { type: 'string' },
        },
        required: ['id', 'surface', 'roman', 'gloss', 'definition', 'spectrum', 'songContext'],
        additionalProperties: false,
      },
    },
  },
  required: ['roman', 'wordByWord', 'direct', 'natural', 'tokens'],
  additionalProperties: false,
};

export interface RetranslateLine {
  roman: string;
  wordByWord: string;
  direct: string;
  natural: string;
  tokens: import('./types').LyricToken[];
}

export async function retranslateLine(
  env: Env,
  targetLineId: string,
  allLines: Array<{ lineId: string; target: string; roman: string }>,
  songTitle: string,
  artist: string,
  feedback?: string
): Promise<RetranslateLine> {
  const systemPrompt = `You are an expert South Asian song translator for a language-learning app.

You are given all lines of a song for context, with one line marked as TARGET.
Produce translations ONLY for the TARGET line.

${ROMANIZATION_TABLE}

Output fields:
- roman: beginner-friendly Latin transliteration, no diacritics — follow canonical table
- wordByWord: token-order English gloss, intentionally ungrammatical, lowercase, compact
- direct: literal + grammatical English, plain and neutral
- natural: emotionally faithful, fluent, conversational English
- tokens: per-word educational breakdown of the TARGET line (7 fields each):
  · id: t001, t002, ... · surface · roman (follow canonical table) · gloss (1–4 words)
  · definition: textbook dictionary entry — part of speech, full core meaning, origin/register note, how native speakers use it. 2–4 sentences. General lexical entry, not specific to this song.
  · spectrum: learner-oriented, compact, comparison-based. Short contrast patterns, max 12 words per alternative. Use "" only if no meaningful alternatives exist. Roman script only — no native script characters.
  · songContext: single concise sentence, max 15 words. Explain why this word was chosen in this lyric. Do not restate the gloss or spectrum. For common grammatical particles (ka, ki, ke, se, ne, ko, bhi, hi, to, na, etc.), give a concise learner-focused grammar note instead of leaving empty when helpful.

${TRANSLATION_HIERARCHY}

GRAMMATICAL INDEPENDENCE — CRITICAL:
The natural translation must read as a grammatically self-contained English lyric line.
Use neighboring lines for emotional interpretation, ambiguity resolution, and pronoun reference.
Do NOT import English connector words (that, because, so that, therefore) from adjacent lines unless the TARGET line itself contains that structure.

${FRAGMENT_NOTE}

Rules:
- direct and natural must be fully English — no Devanagari/Arabic/Bengali characters
- direct and natural must be meaningfully different from each other
- natural may smooth English and clarify implied meaning, but MUST NOT introduce new actors, locations, emotions, intentions, relationships, or imagery that do not exist in the original lyric
- natural may improve fluency and readability, but must stay as close as possible to the original meaning
- natural MUST NOT introduce new tense, certainty, emphasis, time references, motivations, or emotional conclusions that are not explicitly present in the lyric
- natural MUST NOT introduce new tense, certainty, frequency, emphasis, emotional conclusions, or implied facts not explicitly present in the lyric
- No tense shifts: present stays present, question stays question — BAD: "was standing" for present; GOOD: "am standing"
- No frequency additions: do not add "never", "always", "ever" unless the original says so
- No emphasis additions: do not add "really", "so", "truly", "completely"
- No invented adjectives or descriptors not present in the original
- No meaning substitution: translate the actual word — BAD: "bewitched" for दीवाना; GOOD: "devoted" or "lost in you"; BAD: "I admit" for माना; GOOD: "Granted" or "Even so"
- No new time references: do not add "for a while", "for a moment", "still" unless the original says so
- No certainty shifts: do not turn questions or uncertainty into statements
- Never leave South Asian words untranslated
- Return ONLY the JSON matching the schema`;

  const contextTable = allLines
    .map(l => {
      const marker = l.lineId === targetLineId ? ' ← TARGET' : '';
      return `${l.lineId} | ${l.target} | ${l.roman}${marker}`;
    })
    .join('\n');

  const userPrompt = `Song: "${songTitle}" by ${artist}

All lines (lineId | native script | romanization):
${contextTable}${feedback ? `\n\nFeedback: ${feedback}` : ''}`;

  const { result } = await callOpenAI<RetranslateLine>(
    env,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    LINE_RETRANSLATE_SCHEMA,
    'line_retranslation'
  );

  return result;
}
