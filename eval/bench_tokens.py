#!/usr/bin/env python3
"""
bench_tokens.py — measure per-line token call latency without generating a full song.

Usage:
  python bench_tokens.py                         # sample 5 lines from latest song
  python bench_tokens.py --song har-baar-b8bea866
  python bench_tokens.py --n 10                  # sample 10 lines
  python bench_tokens.py --lines "l003,l007,l021" # specific line IDs
  python bench_tokens.py --model gpt-4o          # override model (default: gpt-4o)

Env vars required:
  OPENAI_API_KEY
  HUMDARD_API_URL  (optional, default: https://humdard-lyric-api.sh0vel.workers.dev)
"""

import argparse
import asyncio
import json
import os
import random
import time
from pathlib import Path

import urllib.request
import urllib.error


API_URL = os.environ.get("HUMDARD_API_URL", "https://humdard-lyric-api.sh0vel.workers.dev")
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

ROMANIZATION_TABLE = """ROMANIZATION CANONICAL TABLE — use EXACTLY these spellings, never deviate:
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
कुछ            → kuch        कभी              → kabhi       सब             → sab          हमेशा         → hamesha"""

SYSTEM_PROMPT = f"""You are an expert South Asian linguistics educator creating per-word breakdowns for song lyrics.

You are given all lines of a song (lineId | native script | romanization | word-by-word gloss).
Produce a tokens array for EVERY line.

{ROMANIZATION_TABLE}

For each token produce SIX fields:
- id: "t001", "t002", ... (restart per line)
- surface: exact substring from the native script line
- roman: romanization of that token — follow canonical table, no diacritics
- gloss: short English meaning (1–4 words)
- definition: learner-focused lexical entry. Include part of speech, core meaning (1–2 sentences), a register/origin note only if genuinely useful (e.g. Persian, Sanskrit, Urdu literary), native usage insight explaining how speakers actually use the word especially where it differs from the English gloss, and optionally a short common collocation. Teach the word as a living part of the language — prioritize nuance, semantic range, and what would surprise a learner. 3–6 sentences. Do not reference this song or lyric. Avoid anatomical descriptions, encyclopedic detail, or overly formal language.
- spectrum: Nearby synonyms/alternatives. Format EXACTLY as semicolon-separated "word = meaning" pairs: "jaana = to go; nikalna = to exit; chalna = to walk". Roman script only — no native script characters. 2–4 entries. Use "" only if no meaningful alternatives exist.
- songContext: Single concise sentence, max 15 words. Explain why THIS word was chosen in this lyric — its tone, imagery, or emotional effect. Do not restate the gloss or spectrum. For grammatical particles (ka, ki, ke, se, ne, ko, bhi, hi, to, na, etc.), give a concise learner-focused grammar note instead.

RULES:
- Every word in the line must have exactly one token (including particles)
- Hyphenated compounds (e.g. dil-e-bechain, dard-o-sitam, yaar-e-man, shab-o-roz) are ONE token — never split on hyphens, izāfat (-e-), or conjunctive (-o-). Gloss and surface cover the full compound.
- surface must be an exact substring of the native script target
- Return ONLY the JSON matching the schema"""

TOKEN_SCHEMA = {
    "type": "object",
    "properties": {
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "lineId": {"type": "string"},
                    "tokens": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id":          {"type": "string"},
                                "surface":     {"type": "string"},
                                "roman":       {"type": "string"},
                                "gloss":       {"type": "string"},
                                "definition":  {"type": "string"},
                                "spectrum":    {"type": "string"},
                                "songContext": {"type": "string"},
                            },
                            "required": ["id","surface","roman","gloss","definition","spectrum","songContext"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["lineId", "tokens"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["lines"],
    "additionalProperties": False,
}


def fetch_json(url, method="GET", body=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body else None
    with urllib.request.urlopen(req, data=data, timeout=30) as r:
        return json.loads(r.read())


def fetch_song(song_id):
    return fetch_json(f"{API_URL}/api/songs/{song_id}")


def fetch_latest_song_id():
    data = fetch_json(f"{API_URL}/api/songs")
    return data["songs"][0]["songId"]


def call_token(line, song_title, model, api_key):
    """Call OpenAI for a single line. Returns (elapsed_ms, token_count, line_id)."""
    user_prompt = (
        f'Song: "{song_title}"\n\n'
        f'{line["lineId"]} | {line["target"]} | {line["roman"]}\n\n'
        f'Produce tokens for this line.'
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": user_prompt},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "tokens", "strict": True, "schema": TOKEN_SCHEMA},
        },
    }
    req = urllib.request.Request(OPENAI_URL, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {api_key}")

    t0 = time.perf_counter()
    with urllib.request.urlopen(req, json.dumps(payload).encode(), timeout=120) as r:
        resp = json.loads(r.read())
    elapsed = (time.perf_counter() - t0) * 1000

    usage = resp.get("usage", {})
    result = json.loads(resp["choices"][0]["message"]["content"])
    token_count = len(result["lines"][0]["tokens"]) if result["lines"] else 0
    return elapsed, usage.get("completion_tokens", 0), token_count, line["lineId"]


async def run_parallel(lines, song_title, model, api_key):
    loop = asyncio.get_event_loop()
    tasks = [
        loop.run_in_executor(None, call_token, line, song_title, model, api_key)
        for line in lines
    ]
    t0 = time.perf_counter()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    wall_ms = (time.perf_counter() - t0) * 1000
    return results, wall_ms


def main():
    parser = argparse.ArgumentParser(description="Benchmark token call latency per line")
    parser.add_argument("--song",  help="Song ID to sample from (default: latest)")
    parser.add_argument("--n",     type=int, default=5, help="Number of lines to sample (default: 5)")
    parser.add_argument("--lines", help="Comma-separated specific lineIds to test")
    parser.add_argument("--model", default="gpt-4o", help="OpenAI model (default: gpt-4o)")
    args = parser.parse_args()

    api_key = os.environ["OPENAI_API_KEY"]

    song_id = args.song or fetch_latest_song_id()
    print(f"Song: {song_id}")
    song = fetch_song(song_id)
    title = song.get("title", "")
    all_lines = [
        {"lineId": l["lineId"], "target": l["text"]["target"], "roman": l["text"]["roman"]}
        for s in song["sections"]
        for l in s["lines"]
        if not l.get("isInstrumental")
    ]

    if args.lines:
        ids = set(args.lines.split(","))
        lines = [l for l in all_lines if l["lineId"] in ids]
    else:
        n = min(args.n, len(all_lines))
        lines = random.sample(all_lines, n)

    print(f"Model: {args.model}")
    print(f"Lines to benchmark: {len(lines)}")
    for l in lines:
        print(f"  {l['lineId']}: {l['roman'][:50]}")
    print()

    results, wall_ms = asyncio.run(run_parallel(lines, title, args.model, api_key))

    timings = []
    print(f"{'LineID':<8} {'Time(ms)':>9} {'CompTok':>8} {'Tokens':>7}  Roman")
    print("-" * 70)
    for r in results:
        if isinstance(r, Exception):
            print(f"  ERROR: {r}")
            continue
        elapsed, comp_tokens, token_count, line_id = r
        timings.append(elapsed)
        roman = next((l["roman"] for l in lines if l["lineId"] == line_id), "")
        print(f"{line_id:<8} {elapsed:>9.0f} {comp_tokens:>8} {token_count:>7}  {roman[:40]}")

    if timings:
        print()
        print(f"  Wall time (parallel): {wall_ms:.0f} ms")
        print(f"  Avg per line:         {sum(timings)/len(timings):.0f} ms")
        print(f"  Min:                  {min(timings):.0f} ms")
        print(f"  Max:                  {max(timings):.0f} ms")
        p95 = sorted(timings)[int(len(timings) * 0.95)]
        print(f"  p95:                  {p95:.0f} ms")


if __name__ == "__main__":
    main()
