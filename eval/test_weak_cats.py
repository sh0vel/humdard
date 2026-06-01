"""
Targeted follow-up eval for the three weak categories:
  1. tense_mood     — test a Hindi/Urdu subjunctive hint
  2. punjabi_vocabulary — test a micro-glossary for archaic Punjabi terms
  3. fragment_continuation — investigate na-particle and fr004/fr005 failures

Run: python3 test_weak_cats.py
Requires: OPENAI_API_KEY in environment
"""

import json, os, time, urllib.request
from pathlib import Path

API_KEY = os.environ["OPENAI_API_KEY"]
MODEL = "gpt-4o"
JUDGE_MODEL = "gpt-4o"

# ── Lines under test ───────────────────────────────────────────────────────────

EVAL_DIR = Path(__file__).parent

with open(EVAL_DIR / "benchmark.json") as f:
    bench = json.load(f)

lines_by_id = {l["id"]: l for l in bench["lines"]}

TENSE_MOOD_IDS    = ["hn005", "hn006", "hn015"]
PUNJABI_VOC_IDS   = ["pn001", "pn002", "pn003", "pn005", "pn006"]
FRAGMENT_IDS      = ["fr001", "fr002", "fr003", "fr004", "hn009", "bn006", "bn007", "fr005", "fr006"]

# ── Hints under test ──────────────────────────────────────────────────────────

BASE_HINT = ""  # no extra hint (production baseline)

TENSE_HINT = """HINDI/URDU SUBJUNCTIVE MOOD — handle carefully:
"kaash" + subjunctive = counterfactual wish: "if only…" / "I wish…"
"jo" clause = conditional/temporal: "when…" / "if…" (NOT "if I…" — preserve the embedded subject)
"ho na ho" = subjunctive negation: "may or may not be" / "whether or not there is"
"kal ho na ho" = "whether or not tomorrow comes" (kal = tomorrow here, not yesterday)
Do NOT add subjects that aren't in the original line."""

PUNJABI_VOCAB_HINT = """PUNJABI ARCHAIC/FOLK VOCABULARY — specialized terms:
pasoori / پسوری = difficulty, plight, predicament (the anguish of an unresolved situation)
dhol / ڈھول = in folk address: beloved, dear one (NOT literal drum when used as a term of endearment)
agg (اگ) = fire; agg lavan = to set on fire / to ignite
pasoori is NOT a proper noun — translate it as its meaning, not a transliteration"""

NA_PARTICLE_HINT = """SOFTENING PARTICLES — do not delete:
"na" at the end of a request/plea = a softening tag ("won't you", "please") — NOT negation and NOT a vocative particle
  "aa jaana na" = come, won't you (keep the softening sense, not "don't come")
  "maang lo na" = just ask for it (gentle imperative)"""

PUNJABI_VOCATIVE_HINT = """PUNJABI VOCATIVES — apply when translating Punjabi lyrics:
"ni" and "ve" are vocative/discourse particles addressing the listener — they are NOT negation words.
  ni → addresses a female companion ("O [girl]", or omit gracefully in English)
  ve → addresses a male companion ("O [man]", or omit gracefully in English)
  sajna → beloved (used as direct address: "O beloved")
Example: "ni chann dhalna" = O [girl], the moon is setting — NOT "no, the moon sets" or "O moon, set"."""

TRANSLATION_HIERARCHY = """SCRIPT PRIORITY — tiered detection, first match wins:
1. Devanagari or Bengali/Tamil script → language is exactly that script's language (Hindi/Bengali/Tamil)
2. Perso-Arabic script + distinctly Punjabi words (ਪੰਜਾਬੀ phonology: aa/oo vowel patterns, dhol/ni/ve particles) → Punjabi
3. Perso-Arabic script, otherwise → Urdu
4. Latin romanisation → infer from vocabulary"""

FRAGMENT_NOTE = """FRAGMENT RULE — critical:
Many lines are intentionally incomplete phrases. Translate only what is present.
Do NOT complete the thought, add implied subjects, or fill in the missing half.
"dil mera" = "my heart" (stop there — the predicate is on the next line)"""

# ── Systems ───────────────────────────────────────────────────────────────────

# For each category we test 3 systems:
#   X = production (gpt-4o + Punjabi vocative hint only)
#   Y = production + category-specific micro-hint
#   Z = production + ALL hints stacked (to check for regressions)

def make_prompt(extra_hints: list[str]) -> str:
    hints_block = "\n\n".join(h for h in extra_hints if h)
    return f"""You are a precise linguistic translator for South Asian songs.

{TRANSLATION_HIERARCHY}

For each line (lineId | native script | romanization), produce a DIRECT English translation:
- Grammatically correct, literal, plain English
- Textbook-style — neutral and clear, no added imagery or emotion
- Fragments are fine if the original is fragmentary
- For repeated lines: direct MUST be identical across all repeats
- Never leave South Asian words untranslated

{PUNJABI_VOCATIVE_HINT}

{hints_block}

{FRAGMENT_NOTE}

Return ONLY the JSON matching the schema."""

# ── OpenAI helpers ────────────────────────────────────────────────────────────

def openai_call(messages, schema, model=MODEL):
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "translations",
                "strict": True,
                "schema": schema,
            }
        },
        "temperature": 0,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

TRANSLATION_SCHEMA = {
    "type": "object",
    "properties": {
        "translations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "lineId": {"type": "string"},
                    "direct": {"type": "string"},
                },
                "required": ["lineId", "direct"],
                "additionalProperties": False,
            }
        }
    },
    "required": ["translations"],
    "additionalProperties": False,
}

def translate_lines(line_ids, prompt):
    results = {}
    # Batch in groups of 20
    for i in range(0, len(line_ids), 20):
        batch = line_ids[i:i+20]
        input_lines = "\n".join(
            f"{lid} | {lines_by_id[lid]['native']} | {lines_by_id[lid]['roman']}"
            for lid in batch
        )
        messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": input_lines},
        ]
        resp = openai_call(messages, TRANSLATION_SCHEMA)
        for t in resp["choices"][0]["message"]["content"]:
            pass
        parsed = json.loads(resp["choices"][0]["message"]["content"])
        for t in parsed["translations"]:
            results[t["lineId"]] = t["direct"]
    return results

# ── Judge ─────────────────────────────────────────────────────────────────────

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "verdicts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "lineId": {"type": "string"},
                    "verdict": {"type": "string", "enum": ["PASS", "FAIL"]},
                    "reason": {"type": "string"},
                },
                "required": ["lineId", "verdict", "reason"],
                "additionalProperties": False,
            }
        }
    },
    "required": ["verdicts"],
    "additionalProperties": False,
}

JUDGE_PROMPT = """You are a strict translation judge for South Asian lyrics.

For each item: compare model_translation to gold_direct.
PASS if the translation is semantically equivalent — same meaning, same mood, same tense.
FAIL if meaning differs, tense/mood is wrong, key words are wrong/missing, or subjects are added/removed.
Minor wording differences (synonyms, article choice) should PASS if meaning is preserved.
Do NOT penalize for style when meaning is correct.

Return verdicts as JSON."""

def judge_lines(line_ids, translations):
    verdicts = {}
    for i in range(0, len(line_ids), 30):
        batch = line_ids[i:i+30]
        items = [
            {
                "lineId": lid,
                "native": lines_by_id[lid]["native"],
                "roman": lines_by_id[lid]["roman"],
                "gold_direct": lines_by_id[lid]["gold_direct"],
                "model_translation": translations.get(lid, ""),
            }
            for lid in batch
        ]
        messages = [
            {"role": "system", "content": JUDGE_PROMPT},
            {"role": "user", "content": json.dumps(items)},
        ]
        resp = openai_call(messages, JUDGE_SCHEMA, model=JUDGE_MODEL)
        parsed = json.loads(resp["choices"][0]["message"]["content"])
        for v in parsed["verdicts"]:
            verdicts[v["lineId"]] = v
    return verdicts

# ── Run experiment ────────────────────────────────────────────────────────────

def run_experiment(name, line_ids, systems: dict[str, str]):
    """
    systems: {label -> system_prompt}
    """
    print(f"\n{'='*60}")
    print(f"EXPERIMENT: {name}  ({len(line_ids)} lines)")
    print(f"{'='*60}")

    translations = {}
    for label, prompt in systems.items():
        print(f"  Translating {label}...", end=" ", flush=True)
        t0 = time.time()
        translations[label] = translate_lines(line_ids, prompt)
        print(f"{time.time()-t0:.0f}s")

    verdicts = {}
    for label in systems:
        print(f"  Judging {label}...", end=" ", flush=True)
        t0 = time.time()
        verdicts[label] = judge_lines(line_ids, translations[label])
        print(f"{time.time()-t0:.0f}s")

    # Print comparison table
    print(f"\n  {'ID':<8}", end="")
    for label in systems:
        print(f"  {label:<12}", end="")
    print("  gold / notes")
    print("  " + "-"*80)

    for lid in line_ids:
        line = lines_by_id[lid]
        row = f"  {lid:<8}"
        for label in systems:
            t = translations[label].get(lid, "?")
            v = verdicts[label].get(lid, {}).get("verdict", "?")
            marker = "✓" if v == "PASS" else "✗"
            truncated = t[:28].ljust(28)
            row += f"  {marker} {truncated}"
        row += f"  ← {line['gold_direct'][:40]}"
        print(row)

    print()
    for lid in line_ids:
        line = lines_by_id[lid]
        print(f"  [{lid}] {line['roman']}")
        for label in systems:
            t = translations[label].get(lid, "?")
            v = verdicts[label].get(lid, {}).get("verdict", "?")
            reason = verdicts[label].get(lid, {}).get("reason", "")[:80]
            print(f"    {label}: [{v}] {t}")
            if v == "FAIL":
                print(f"         reason: {reason}")
        print(f"    gold: {line['gold_direct']}")
        if line.get("notes"):
            print(f"    notes: {line['notes']}")
        print()

    # Accuracy summary
    print("  Accuracy summary:")
    for label in systems:
        n_pass = sum(1 for lid in line_ids if verdicts[label].get(lid, {}).get("verdict") == "PASS")
        print(f"    {label}: {n_pass}/{len(line_ids)} = {n_pass/len(line_ids)*100:.0f}%")

    return translations, verdicts


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Testing weak categories with targeted micro-hints")
    print(f"Model: {MODEL}  |  Judge: {JUDGE_MODEL}")

    # 1. tense_mood
    run_experiment(
        "tense_mood — Hindi/Urdu subjunctive",
        TENSE_MOOD_IDS,
        {
            "X_prod":     make_prompt([]),
            "Y_tense":    make_prompt([TENSE_HINT]),
        }
    )

    # 2. punjabi_vocabulary
    run_experiment(
        "punjabi_vocabulary — archaic Punjabi terms",
        PUNJABI_VOC_IDS,
        {
            "X_prod":     make_prompt([]),
            "Y_vocab":    make_prompt([PUNJABI_VOCAB_HINT]),
        }
    )

    # 3. fragment_continuation — focus on fr004 (na particle) and fr005 (future tense)
    run_experiment(
        "fragment_continuation — na particle & future tense",
        FRAGMENT_IDS,
        {
            "X_prod":     make_prompt([]),
            "Y_na":       make_prompt([NA_PARTICLE_HINT]),
        }
    )

    print("\nDone.")
