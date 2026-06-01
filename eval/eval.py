"""
4-way benchmark eval: accuracy per system, per category, per language.

Systems:
  A — gpt-4o baseline
  B — gpt-4o + Punjabi vocative hint
  C — gpt-4o + full glossary
  D — gpt-4o direct → gpt-5.5 audit → corrected

Metric: PASS/FAIL per line vs gold_direct, judged by gpt-4o.
Reports: overall accuracy, per category, per language, per failure type.
"""
import json, os, time, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]

EVAL_DIR = Path(__file__).parent
with open(EVAL_DIR / "benchmark.json") as f:
    BENCH = json.load(f)
LINES = BENCH["lines"]

# ── Prompts ────────────────────────────────────────────────────────────────────

FRAGMENT_NOTE = """Many lyric lines are incomplete poetic fragments that continue into neighboring lines.
Do NOT force fragmentary lines into complete standalone English sentences.
Preserve fragmentary structure when appropriate."""

BASE_DIRECT = f"""You are a precise linguistic translator for South Asian songs.
For each line (lineId | native script | romanization), produce a DIRECT English translation:
- Grammatically correct, literal, plain English
- Fragments are fine if the original is fragmentary
- Never leave South Asian words untranslated
- Preserve semantic meaning; choose precision over elegance
{FRAGMENT_NOTE}
Return ONLY the JSON matching the schema."""

PUNJABI_HINT = """
PUNJABI VOCATIVES — apply carefully:
In Punjabi lyrics, "ni" and "ve" are vocative/discourse particles addressing the listener — NOT negation words.
  ni  → addresses a female companion ("O [girl]", or omit gracefully in English)
  ve  → addresses a male companion ("O [man]", or omit gracefully in English)
  sajna → beloved (used as address: "O beloved")
These particles attach to the speaker's statement, not to the following noun.
"ni chann dhalna" = O [girl], the moon is setting — NOT "no, the moon sets" or "O moon, set"."""

GLOSSARY = """
LINGUISTIC GLOSSARY — apply precisely:

Punjabi vocatives:
  ni / nī  → female vocative ("O [girl]", NOT "no" or negation)
  ve / vey → male vocative ("O [man]", NOT "hey" dismissively)
  sajna    → beloved (address)

Urdu/Persian vocabulary:
  mohlat   → respite, reprieve, extension of time (NOT chance/opportunity)
  hijr     → separation, parting (NOT distance/longing)
  neer     → water (NOT tears/stream)
  nishan   → mark, trace, sign (NOT scar/wound)
  sadiyan  → centuries (NOT ages/eons/eternity)
  naadaan  → naive, innocent (NOT foolish/stupid)
  ranjish  → bitterness, grudge (NOT anger/jealousy)
  fursat   → leisure, free time (NOT chance/hurry)
  khwaish  → desire, yearning (more intense than wish)
  siwa     → besides, apart from (NOT Shiva the deity)
  mahboob  → beloved (vocative address, NOT just a name)
  chain    → peace, rest, tranquility (NOT metal chain)
  mast     → spiritually intoxicated/ecstatic (NOT English mast)
  lamha    → moment (NOT lamba = long/tall)
  taraf    → direction, side (NOT traffic)
  jaan     → life/soul (NOT the name John)
  pran     → life, vital breath (NOT prayer)
  dor      → string, thread (NOT door)
  sang     → stone (Persian, NOT past tense of sing)

Verbs:
  valna    → turn back (NOT wander/leave)
  pighal   → melt (NOT dissolve/disappear)
  saja hai → is adorned/decorated (NOT placed/sitting)
  milna    → to meet/be found (NOT the distance unit mile)

Izafat (X-e-Y = Y X):
  dil-e-bechain → restless heart (NOT heart of restlessness)
  husn-e-yaar   → beauty of the beloved
  jaan-e-jaan   → soul of my soul
  shab-e-gham   → night of sorrow
  dard-e-dil    → heartache
  mah-jabeen    → moon-browed

Tamil:
  -e suffix on nouns = Tamil vocative (Nenjame = O heart, Uyire = O my life)
  nee = you (NOT negation)
  kaadhal = romantic love
  vaan = sky (NOT van the vehicle)

Bengali:
  mon = heart AND mind (one word covers both)
  go = emphasis particle (NOT the motion verb)
  re = emphatic/expressive particle at sentence end (NOT negation)
  pran = life/soul/vital force (NOT prayer)
  bhalobasha = love (noun)
  akash = sky
  nodi = river"""

HINT_DIRECT  = BASE_DIRECT.replace(FRAGMENT_NOTE, PUNJABI_HINT + "\n" + FRAGMENT_NOTE)
GLOSS_DIRECT = BASE_DIRECT.replace(FRAGMENT_NOTE, GLOSSARY + "\n" + FRAGMENT_NOTE)

AUDIT_PROMPT = """You are a linguistic QA reviewer. Detect genuine linguistic errors only.
Check: incorrect word meaning, tense/pronoun errors, Punjabi vocatives (ni/ve ≠ negation),
Urdu vocabulary (mohlat/hijr/sadiyan/neer), izafat constructions, ambiguity loss, meaning additions.
Do NOT flag style, fluency, or preference differences.
KEEP if acceptable. REPLACE only for genuine linguistic errors.
Return ONLY the JSON matching the schema."""

JUDGE_PROMPT = """You are a translation quality judge.

For each line you receive:
  lineId | native | roman | gold_direct | model_translation | known_failure_type

Decide PASS or FAIL:
  PASS — translation is semantically equivalent to gold_direct (minor wording differences OK)
  FAIL — genuine linguistic error: wrong word meaning, wrong actor, added/removed content,
         wrong tense/pronoun, vocative misread as negation, untranslated words, etc.

The known_failure_type tells you what error to specifically watch for.
But also flag OTHER errors not listed.
Be strict: if it materially changes meaning or introduces content not in the gold, FAIL it.
Return ONLY the JSON matching the schema."""

# ── Schemas ────────────────────────────────────────────────────────────────────

TRANS_SCHEMA = {
    "type": "object", "properties": {"lines": {"type": "array", "items": {
        "type": "object",
        "properties": {"lineId": {"type": "string"}, "translation": {"type": "string"}},
        "required": ["lineId", "translation"], "additionalProperties": False
    }}}, "required": ["lines"], "additionalProperties": False
}
AUDIT_SCHEMA = {
    "type": "object", "properties": {"lines": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "lineId": {"type": "string"}, "status": {"type": "string", "enum": ["KEEP", "REPLACE"]},
            "reason": {"type": "string"}, "correctedTranslation": {"type": "string"},
        },
        "required": ["lineId", "status", "reason", "correctedTranslation"],
        "additionalProperties": False
    }}}, "required": ["lines"], "additionalProperties": False
}
JUDGE_SCHEMA = {
    "type": "object", "properties": {"evaluations": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "lineId": {"type": "string"},
            "verdict": {"type": "string", "enum": ["PASS", "FAIL"]},
            "reason": {"type": "string"},
        },
        "required": ["lineId", "verdict", "reason"], "additionalProperties": False
    }}}, "required": ["evaluations"], "additionalProperties": False
}

# ── API call ───────────────────────────────────────────────────────────────────

def _oai(model, system, user, schema, name):
    body = json.dumps({"model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_schema", "json_schema": {"name": name, "strict": True, "schema": schema}}
    }).encode()
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {OPENAI_API_KEY}"},
        method="POST")
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as r:
        resp = json.loads(r.read())
    ms = int((time.time() - t0) * 1000)
    content = json.loads(resp["choices"][0]["message"]["content"])
    return content, ms

# ── Translation helpers ────────────────────────────────────────────────────────

BATCH = 25  # lines per translation call — keep small to avoid structured-output degradation

def make_user_msg(lines):
    return ("Lines (lineId | native script | romanization):\n" +
            "\n".join(f"{l['id']} | {l['native']} | {l['roman']}" for l in lines) +
            "\n\nProduce direct translation for each lineId.")

def translate(system_prompt, label):
    print(f"  translating {label} ({len(LINES)} lines in batches of {BATCH})...", flush=True)
    t0 = time.time()
    out = {}
    total_ms = 0
    for i in range(0, len(LINES), BATCH):
        batch = LINES[i:i+BATCH]
        result, ms = _oai("gpt-4o", system_prompt, make_user_msg(batch), TRANS_SCHEMA, f"trans_{label}_{i}")
        total_ms += ms
        for l in result["lines"]:
            out[l["lineId"]] = l["translation"]
    print(f"    {label} done {total_ms}ms", flush=True)
    return out, total_ms

def translate_with_audit(label="D"):
    print(f"  translating {label} (gpt-4o, batches of {BATCH})...", flush=True)
    drafts = {}
    ms1 = 0
    for i in range(0, len(LINES), BATCH):
        batch = LINES[i:i+BATCH]
        result, ms = _oai("gpt-4o", BASE_DIRECT, make_user_msg(batch), TRANS_SCHEMA, f"trans_D_{i}")
        ms1 += ms
        for l in result["lines"]:
            drafts[l["lineId"]] = l["translation"]
    print(f"    draft done {ms1}ms  |  auditing (gpt-5.5, single call)...", flush=True)

    audit_user = (
        "Lines (lineId | native | roman | translation):\n" +
        "\n".join(f"{l['id']} | {l['native']} | {l['roman']} | {drafts[l['id']]}" for l in LINES) +
        "\n\nFor each: KEEP if acceptable. REPLACE only for genuine linguistic errors."
    )
    audit_result, ms2 = _oai("gpt-5.5", AUDIT_PROMPT, audit_user, AUDIT_SCHEMA, "audit_D")
    patches = {e["lineId"]: e for e in audit_result["lines"]}

    final = {}
    n_replaced = 0
    for l in LINES:
        lid = l["id"]
        e = patches.get(lid, {"status": "KEEP"})
        if e["status"] == "REPLACE":
            final[lid] = e["correctedTranslation"]
            n_replaced += 1
        else:
            final[lid] = drafts[lid]

    total_ms = ms1 + ms2
    print(f"    audit done {ms2}ms  |  {n_replaced} corrections  |  total {total_ms}ms", flush=True)
    return final, total_ms, n_replaced

# ── Judge ──────────────────────────────────────────────────────────────────────

JUDGE_BATCH = 30

def judge(translations, label):
    print(f"  judging {label} (batches of {JUDGE_BATCH})...", flush=True)
    evals = {}
    total_ms = 0
    for i in range(0, len(LINES), JUDGE_BATCH):
        batch = LINES[i:i+JUDGE_BATCH]
        entries = [
            {
                "lineId": l["id"],
                "native": l["native"],
                "roman": l["roman"],
                "gold_direct": l["gold_direct"],
                "model_translation": translations.get(l["id"], "???"),
                "known_failure": l.get("known_failure", ""),
            }
            for l in batch
        ]
        user = (
            "Evaluate these translations (JSON array):\n" +
            json.dumps(entries, ensure_ascii=False) +
            "\n\nFor each: PASS if semantically equivalent to gold_direct, FAIL if genuine error."
        )
        result, ms = _oai("gpt-4o", JUDGE_PROMPT, user, JUDGE_SCHEMA, f"judge_{label}_{i}")
        total_ms += ms
        for e in result["evaluations"]:
            evals[e["lineId"]] = e
    print(f"    judge {label} done {total_ms}ms", flush=True)
    return evals, total_ms

# ── Run all systems ────────────────────────────────────────────────────────────

print(f"Benchmark: {len(LINES)} lines\n")
print("Step 1/2 — translations (A/B/C parallel, D sequential)...")

results = {}
timings = {}

with ThreadPoolExecutor(max_workers=3) as ex:
    futures = {
        ex.submit(translate, BASE_DIRECT,  "A"): "A",
        ex.submit(translate, HINT_DIRECT,  "B"): "B",
        ex.submit(translate, GLOSS_DIRECT, "C"): "C",
    }
    for fut in as_completed(futures):
        key = futures[fut]
        trans, ms = fut.result()
        results[key] = trans
        timings[key] = ms

trans_D, ms_D, n_patched = translate_with_audit("D")
results["D"] = trans_D
timings["D"] = ms_D

print(f"\nStep 2/2 — judging all systems...")
verdicts = {}
judge_ms = {}
for sys in ["A", "B", "C", "D"]:
    v, ms = judge(results[sys], sys)
    verdicts[sys] = v
    judge_ms[sys] = ms

# ── Scoring ────────────────────────────────────────────────────────────────────

def score(sys_verdicts):
    by_cat   = defaultdict(lambda: {"pass": 0, "total": 0})
    by_lang  = defaultdict(lambda: {"pass": 0, "total": 0})
    overall  = {"pass": 0, "total": 0}
    fails    = []

    for l in LINES:
        lid = l["id"]
        v = sys_verdicts.get(lid, {})
        verdict = v.get("verdict", "FAIL")
        cat  = l["category"]
        lang = l.get("language", "?")

        overall["total"] += 1
        by_cat[cat]["total"] += 1
        by_lang[lang]["total"] += 1

        if verdict == "PASS":
            overall["pass"] += 1
            by_cat[cat]["pass"] += 1
            by_lang[lang]["pass"] += 1
        else:
            fails.append((lid, l["category"], l.get("language","?"), v.get("reason","?")))

    return overall, dict(by_cat), dict(by_lang), fails

scores = {sys: score(verdicts[sys]) for sys in ["A","B","C","D"]}

# ── Print results ──────────────────────────────────────────────────────────────

N = len(LINES)
print(f"\n{'='*72}")
print(f"RESULTS  ({N} lines)\n")

print(f"{'System':<6} {'Overall':>8}  {'Time':>8}  {'Description'}")
print(f"{'─'*60}")
descs = {"A": "gpt-4o baseline", "B": "gpt-4o + Punjabi hint",
         "C": "gpt-4o + glossary", "D": "gpt-4o + gpt-5.5 audit"}
for sys in ["A","B","C","D"]:
    ov = scores[sys][0]
    pct = ov["pass"] / ov["total"] * 100
    print(f"  {sys}      {ov['pass']:>3}/{ov['total']}  {pct:>5.1f}%    {timings[sys]:>6}ms    {descs[sys]}")

print(f"\n── By category {'─'*56}")
all_cats = sorted({l["category"] for l in LINES})
header = f"{'Category':<30}" + "".join(f"  {s:>5}" for s in ["A","B","C","D"])
print(header)
print("─" * 52)
for cat in all_cats:
    row = f"{cat:<30}"
    for sys in ["A","B","C","D"]:
        d = scores[sys][1].get(cat, {"pass":0,"total":0})
        if d["total"] == 0:
            row += "     —"
        else:
            pct = d["pass"] / d["total"] * 100
            row += f"  {pct:>4.0f}%"
    n = scores["A"][1].get(cat,{}).get("total",0)
    print(row + f"   (n={n})")

print(f"\n── By language {'─'*57}")
all_langs = sorted({l.get("language","?") for l in LINES})
header = f"{'Language':<22}" + "".join(f"  {s:>5}" for s in ["A","B","C","D"])
print(header)
print("─" * 44)
for lang in all_langs:
    row = f"{lang:<22}"
    for sys in ["A","B","C","D"]:
        d = scores[sys][2].get(lang, {"pass":0,"total":0})
        if d["total"] == 0:
            row += "     —"
        else:
            pct = d["pass"] / d["total"] * 100
            row += f"  {pct:>4.0f}%"
    n = scores["A"][2].get(lang,{}).get("total",0)
    print(row + f"   (n={n})")

# ── Print failures per system ──────────────────────────────────────────────────
for sys in ["A","B","C","D"]:
    fails = scores[sys][3]
    print(f"\n── System {sys} failures ({len(fails)}/{N}) {'─'*40}")
    if not fails:
        print("  (none)")
    for lid, cat, lang, reason in sorted(fails, key=lambda x: x[1]):
        line = next(l for l in LINES if l["id"] == lid)
        print(f"  [{lid}] ({cat} / {lang})")
        print(f"    native  : {line['native']}")
        print(f"    gold    : {line['gold_direct']}")
        print(f"    model   : {results[sys].get(lid,'???')}")
        print(f"    reason  : {reason[:120]}")

print(f"\n{'='*72}")
print(f"TIMING SUMMARY")
print(f"  A (baseline):      {timings['A']:>6}ms + {judge_ms['A']:>5}ms judge")
print(f"  B (hint):          {timings['B']:>6}ms + {judge_ms['B']:>5}ms judge")
print(f"  C (glossary):      {timings['C']:>6}ms + {judge_ms['C']:>5}ms judge")
print(f"  D (4o+5.5-audit):  {timings['D']:>6}ms + {judge_ms['D']:>5}ms judge  ({n_patched} patches)")
print(f"\n  (Judge time is offline eval cost, not production latency)")

# Save full results
output = {
    "benchmark_version": BENCH["_meta"]["version"],
    "n_lines": N,
    "systems": {
        sys: {
            "desc": descs[sys],
            "translation_ms": timings[sys],
            "overall_accuracy": scores[sys][0]["pass"] / scores[sys][0]["total"],
            "by_category": {
                cat: {"pass": d["pass"], "total": d["total"],
                      "accuracy": d["pass"]/d["total"] if d["total"] else 0}
                for cat, d in scores[sys][1].items()
            },
            "by_language": {
                lang: {"pass": d["pass"], "total": d["total"],
                       "accuracy": d["pass"]/d["total"] if d["total"] else 0}
                for lang, d in scores[sys][2].items()
            },
            "translations": results[sys],
            "verdicts": {lid: v for lid, v in verdicts[sys].items()},
        }
        for sys in ["A","B","C","D"]
    }
}
out_path = EVAL_DIR / "results.json"
with open(out_path, "w") as f:
    json.dump(output, f, ensure_ascii=False, indent=2)
print(f"\nFull results saved to {out_path}")
