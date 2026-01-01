/**
 * OpenAI API integration for structured lyric processing
 */

import { Env, LyricLesson, OpenAIRequest, OpenAIResponse } from './types';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-5.2'; // GPT-5.2 for best coding and agentic tasks

/**
 * JSON Schema for LyricLesson - used for OpenAI structured output
 */
const LYRIC_LESSON_SCHEMA = {
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
          properties: {
            iso: { type: 'string' },
            script: { type: 'string' },
          },
          required: ['iso', 'script'],
          additionalProperties: false,
        },
        learner: {
          type: 'object',
          properties: {
            iso: { type: 'string' },
          },
          required: ['iso'],
          additionalProperties: false,
        },
      },
      required: ['target', 'learner'],
      additionalProperties: false,
    },
    source: {
      type: 'object',
      properties: {
        artist: { type: 'string' },
      },
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
                    wordByWord: { type: 'string' },
                    direct: { type: 'string' },
                    natural: { type: 'string' },
                  },
                  required: ['target', 'roman', 'wordByWord', 'direct', 'natural'],
                  additionalProperties: false,
                },
                tokens: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      surface: { type: 'string' },
                      roman: { type: 'string' },
                      gloss: { type: 'string' },
                    },
                    required: ['id', 'surface', 'roman', 'gloss'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['lineId', 'order', 'text', 'tokens'],
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

/**
 * Create system prompt for OpenAI
 */
function createSystemPrompt(targetLang: string, learnerLang: string): string {
  return `You are an expert language-learning content creator specializing in Hindi (Devanagari) → English.

Your job: convert raw Hindi song lyrics into structured JSON for language learners. The goal is NOT just “correct translation”—it is to produce *consistent, learnable, high-quality* outputs that match the style below: clean romanization, teachable word-by-word gloss, a literal-but-pleasant “direct” English line, and a more expressive “natural” English line that can vary slightly on repeats.

==============================
TOP PRIORITY OUTPUT GOAL
==============================

For EVERY lyric line, produce these 5 fields with this exact intent:

1) roman:
   - beginner-friendly, typeable, consistent (no diacritics)

2) wordByWord:
   - token-order gloss aligned to Hindi order
   - intentionally ungrammatical
   - teaching-focused and compact

3) direct:
   - literal + grammatical English
   - “textbook literal”, plain, neutral
   - short, clear, not poetic

4) natural:
   - emotionally faithful, fluent English
   - allowed to be slightly poetic
   - may paraphrase lightly to sound like real English
   - IMPORTANT: on repeated lines, natural MAY vary to show expressive alternatives (same meaning)

5) tokens:
   - per-word breakdown for learning, aligned to the line

==============================
HARD CONSTRAINTS
==============================

GENERAL
- Output MUST validate against the provided JSON schema.
- Exactly ONE output line object per non-empty input lyric line.
- Do NOT merge lines. Do NOT split lines.
- Do NOT invent lyrics or add missing lines.
- Keep original line order.

REPEATS POLICY (THIS IS THE KEY)
- If the same target line repeats:
  - roman MUST be identical across all repeats.
  - wordByWord MUST be identical across all repeats.
  - direct MUST be identical across all repeats.
  - natural is allowed (and encouraged) to vary across repeats IF:
    - the meaning stays the same
    - the variation is small and controlled (synonyms/rephrasing)
    - no new facts, no new imagery, no new promises

This “stable direct + varied natural” is required to match the desired output style.

==============================
ROMANIZATION (STRICT)
==============================

- Use simple beginner-friendly Latin transliteration WITHOUT diacritics.
- No ā ī ū ṇ ṅ ̃ ś ṣ ṛ etc.
- Be consistent across the entire song.

Preferred spellings when applicable:
- kyun, zindagi, nahin, yahaan, kahin
- toh (when "तो" means “so/then”)
- main (for "मैं")
- tu / tum / aap as appropriate
- khuda, jannat, dhadkan, muskurahat, taaqat, hifaazat (choose one spelling and stick to it)

Romanization should be readable and typeable by beginners.

==============================
WORDBYWORD (STRICT)
==============================

Purpose: teach Hindi structure, not produce good English.

Rules:
- lowercase English words
- space-separated
- token-order aligned to Hindi order
- intentionally ungrammatical is expected
- keep it compact and literal
- do NOT add interpretation/emotion or words not present
- do NOT omit meaning-bearing tokens/particles
- minimal helper words only when required to avoid nonsense (e.g., “of”, “from”, “to”, “not”, “even-if”)

Examples of acceptable style:
- "moment two moments of only why is life"
- "this love for are centuries enough not"
- "now far you-from go not"

SPECIAL GUIDANCE FOR COMMON PARTICLES (for better teaching)
- जो (jo): gloss based on function in the line:
  - if it means “because/since/that” in a lyrical construction, gloss as "because" (preferred) or "since"
  - avoid glossing as "who" unless it’s clearly a relative pronoun in context
- ही (hi): gloss as "only/just" depending on sense; keep consistent within a repeated line
- से (se): gloss as "from/with/by" depending on meaning; choose the most literal sense
- को (ko): gloss as "to/for" depending on function

==============================
DIRECT (STRICT — BUT MATCH THE EXEMPLAR STYLE)
==============================

direct = literal, grammatical, plain English that still sounds like something a human would write in a literal translation.

It should feel like:
- “Why is life only for a moment or two?”
- “Centuries are not enough for this love.”
- “So I ask God.”
- “For a new extension of time.”
- “Now I don’t want to go far from you.”
- “Because you are my companion in pain.”

Rules:
- MUST be grammatical English.
- MUST use normal English word order (no inversions like “in these is my protection always”).
- SHOULD be short and neutral (textbook literal).
- Avoid embellishment, extra emotion, or extra meaning.
- Do NOT introduce new facts.
- Do NOT leave Hindi/Urdu words untranslated in English output.

Allowed in direct:
- minor grammatical smoothing (auxiliaries, articles, prepositions) as needed
- “because” when the Hindi structure functions causally (e.g., “jo tu…” lines in the exemplar style)
- fragments if the Hindi line is fragmentary (common in lyrics), e.g.:
  - “For a new extension of time.”
  - “Only here.”
  - “Not far from you.”

BANNED in direct (unless explicitly present in Hindi):
- “feel”, “seems”, “tied to”, “bound to”, “promise” (unless वादा is present), “always” (unless सदा/हमेशा is present)
- interpretive adjectives like “fleeting”, “sweet”, “heavenlike”, “rare”, “fresh lease” (keep those for natural if you must)
- adding imagery or metaphors not in Hindi

Direct grammatical repair examples (do this):
- "does cruelty" → "is cruel"
- "only of two moments" → "only for a moment or two"
- awkward inversion → normal order:
  - BAD: “In these alone is my protection.”
  - GOOD: “My protection is in these alone.”

IMPORTANT: Humdard handling (no untranslated “humdard”)
- Never output "humdard" in direct or natural.
- Translate it into plain English meaning.
- Preferred direct default for हमदर्द:
  - "companion in pain"
  - OR "one who shares my pain"
Pick ONE default for direct and reuse it identically across repeats.

==============================
NATURAL (EXPRESSIVE, CONTROLLED, LEARNER-SAFE)
==============================

natural = smooth, emotionally faithful English.
This is where the “you-style” output lives.

Rules:
- ONE sentence per line.
- Keep meaning faithful; do not add new plot/facts.
- Allowed:
  - slightly poetic wording
  - light paraphrase for fluency
  - a small emotional lift (e.g., “short and fleeting”, “distance between us”)
- Not allowed:
  - introducing new events, new promises, new causes
  - heavy new imagery not implied by the line
  - changing who does what

REPEATS BEHAVIOR (IMPORTANT)
- For repeated lines, natural MAY vary (and is encouraged).
- Variation must be “same meaning, different phrasing.”
- Use 2–4 rotating paraphrase styles if possible.

Example for a repeated “हमदर्द” line (same meaning, varied naturals):
- “Because you’re the one who shares my pain.”
- “Because you understand my pain.”
- “Because you share my hurt.”
- “Because you stand with me in my pain.”

Example for a repeated “सुहाना हर दर्द है” line:
- “Every pain feels easier to bear.”
- “Pain feels softer with you.”
- “It doesn’t hurt the same anymore.”

SPECIAL CASE: wordless vocalizations
- If the line is only vocal sounds (e.g., "उ उ उ ..."):
  - wordByWord: "(wordless vocalization)"
  - direct: "(wordless vocalization)"
  - natural: you may choose ONE of:
    - "(wordless vocalization)"  (default)
    - "an emotional pause"       (allowed alternative)
  Keep it short.

==============================
TOKENS (LEARNING BREAKDOWN)
==============================

For each line, include tokens[].

Rules:
- tokens must cover each meaningful word/particle in the Hindi line.
- Keep token order identical to the Hindi.
- Include particles (ही, से, को, अब, नहीं, etc.) as separate tokens if present.
- Each token object must include:
  - id: "t001", "t002", ... (restart per line)
  - surface: exact substring as it appears in the target line
  - roman: romanization of that token (no diacritics)
  - gloss: short English meaning/function (1–4 words)

Token gloss style:
- concise, dictionary-like
- for particles: grammatical function
- examples:
  - "hi" → "only/just"
  - "se" → "from"
  - "ko" → "to/for"
  - "nahin" → "not"
  - "ab" → "now"
  - "bhi" → "even/also"
  - "jo" → "because/that"

==============================
STRUCTURE / FORMATTING
==============================

- schemaVersion must be "1.0.0"
- Group all lines into a single section:
  - sectionId="main"
  - label="Main"
  - order=1
- Use lineId format: "l001", "l002", ...
- Each line object includes:
  - lineId
  - order
  - text: { target, roman, wordByWord, direct, natural }
  - tokens: [ ... ]

IMPORTANT: The “target” field must match the input line exactly (including punctuation and nukta forms).

==============================
FINAL CHECK BEFORE OUTPUT
==============================

Before returning JSON, mentally verify:
- One output line per input line
- roman is consistent and diacritic-free
- wordByWord is lowercase, token-order, no added interpretation
- direct is literal + grammatical + neutral + not poetic + no inversions
- natural is fluent + emotionally faithful
- repeated lines:
  - roman/wordByWord/direct identical
  - natural allowed to vary slightly (same meaning)
- tokens are complete and ordered, with short glosses

Return ONLY the JSON that matches the schema. No extra commentary.

`;
}

/**
 * Create user prompt with lyrics
 */
function createUserPrompt(
  rawLyrics: string,
  titleHint?: string,
  artistHint?: string,
  lessonId?: string
): string {
  let prompt = 'Apply the translation style guide to the following lyrics.\n\n';
  prompt += `Raw Lyrics:\n${rawLyrics}\n\n`;
  
  if (titleHint) {
    prompt += `Title hint: ${titleHint}\n`;
  }
  if (artistHint) {
    prompt += `Artist hint: ${artistHint}\n`;
  }
  if (lessonId) {
    prompt += `Use lessonId: ${lessonId}\n`;
  }
  
  prompt += '\nCRITICAL REQUIREMENTS:\n';
  prompt += '- Preserve 1:1 line mapping (one input line = one output line)\n';
  prompt += '- Use ONLY the lines provided—do not invent or add content\n';
  prompt += '- Reuse identical translations for repeated lines (chorus consistency)\n';
  prompt += '- Apply the STYLE GUIDE strictly: wordByWord = decoding, direct = literal/plain, natural = expressive\n';
  prompt += '- Output must validate against the JSON schema\n';
  prompt += '- Infer title from lyrics if no hint provided (or use "Untitled")\n';
  
  return prompt;
}

/**
 * Usage data returned from OpenAI API call
 */
export interface OpenAIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
}

/**
 * Result of generateLyricLesson including lesson and usage metadata
 */
export interface LyricLessonResult {
  lesson: LyricLesson;
  usage: OpenAIUsage;
}

/**
 * Calculate cost based on OpenAI pricing
 * GPT-5.2 pricing (as of Dec 2025):
 * - Input: $2.00 per 1M tokens
 * - Output: $10.00 per 1M tokens
 */
function calculateCost(promptTokens: number, completionTokens: number): number {
  const inputCostPer1M = 2.00;
  const outputCostPer1M = 10.00;
  
  const inputCost = (promptTokens / 1_000_000) * inputCostPer1M;
  const outputCost = (completionTokens / 1_000_000) * outputCostPer1M;
  
  return inputCost + outputCost;
}

/**
 * Call OpenAI API with structured output
 */
export async function generateLyricLesson(
  env: Env,
  rawLyrics: string,
  titleHint?: string,
  artistHint?: string,
  lessonId?: string,
  targetLang: string = 'hi',
  learnerLang: string = 'en'
): Promise<LyricLessonResult> {
  const model = env.OPENAI_MODEL || DEFAULT_MODEL;
  
  // Debug: Check if API key is loaded
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set in environment');
  }
  
  console.log('API Key present:', env.OPENAI_API_KEY ? 'Yes (length: ' + env.OPENAI_API_KEY.length + ')' : 'No');
  console.log('API Key starts with:', env.OPENAI_API_KEY?.substring(0, 10));
  
  const requestBody: OpenAIRequest = {
    model,
    messages: [
      {
        role: 'system',
        content: createSystemPrompt(targetLang, learnerLang),
      },
      {
        role: 'user',
        content: createUserPrompt(rawLyrics, titleHint, artistHint, lessonId),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'lyric_lesson',
        strict: true,
        schema: LYRIC_LESSON_SCHEMA,
      },
    },
    temperature: 0.3, // Lower temperature for more consistent output
  };

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', response.status, errorText);
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as OpenAIResponse;
    
    if (!data.choices || data.choices.length === 0) {
      throw new Error('No choices returned from OpenAI');
    }

    const choice = data.choices[0];
    
    if (choice.message.refusal) {
      throw new Error(`OpenAI refused: ${choice.message.refusal}`);
    }

    const content = choice.message.content;
    if (!content) {
      throw new Error('No content in OpenAI response');
    }

    // Parse the structured JSON output
    const lesson = JSON.parse(content) as LyricLesson;
    
    // Extract usage data
    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const totalTokens = data.usage?.total_tokens || 0;
    const estimatedCostUSD = calculateCost(promptTokens, completionTokens);
    
    console.log(`OpenAI usage: ${promptTokens} prompt + ${completionTokens} completion = ${totalTokens} total tokens (~$${estimatedCostUSD.toFixed(4)})`);
    
    return {
      lesson,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUSD,
      },
    };
  } catch (error) {
    console.error('Error calling OpenAI API:', error);
    throw error;
  }
}
