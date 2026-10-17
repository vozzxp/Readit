"""Offline dictionary lookups (WordNet 3.0 + CMU pronunciations) from a local SQLite file.

Build the database once with:  python3 setup_dictionary.py
"""
import re
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().with_name("dictionary.sqlite")

POS_NAMES = {"n": "noun", "v": "verb", "a": "adjective", "r": "adverb"}
POS_ABBR = {"n": "n.", "v": "v.", "a": "adj.", "r": "adv."}

# WordNet "morphy" detachment rules (plus a few extras for -ied / doubled consonants)
RULES = {
    "n": [("s", ""), ("ses", "s"), ("xes", "x"), ("zes", "z"), ("ches", "ch"),
          ("shes", "sh"), ("men", "man"), ("ies", "y")],
    "v": [("s", ""), ("ies", "y"), ("es", "e"), ("es", ""), ("ed", "e"), ("ed", ""),
          ("ied", "y"), ("ing", "e"), ("ing", "")],
    "a": [("er", ""), ("est", ""), ("er", "e"), ("est", "e"), ("ier", "y"), ("iest", "y")],
}

_conn = None


def available() -> bool:
    return DB_PATH.is_file()


def _connect():
    global _conn
    if _conn is None and DB_PATH.is_file():
        try:
            _conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False)
        except sqlite3.Error:
            _conn = None
    return _conn


def _normalize(text: str) -> str:
    t = re.sub(r"\s+", " ", text.strip().lower().replace("\u2019", "'"))
    return re.sub(r"^[^\w]+|[^\w]+$", "", t)


def _candidates(word: str):
    """Yield possible base forms of an inflected word, most likely first."""
    seen = set()
    for pos in ("n", "v", "a"):
        for suffix, repl in RULES[pos]:
            if word.endswith(suffix) and len(word) - len(suffix) >= 2:
                stem = word[: len(word) - len(suffix)] + repl
                options = [stem]
                if suffix in ("ing", "ed", "er", "est") and not repl and len(stem) > 2 and stem[-1] == stem[-2]:
                    options.append(stem[:-1])  # running -> run
                for o in options:
                    if o not in seen:
                        seen.add(o)
                        yield o


def lookup(text: str, max_senses: int = 6):
    """Return {"word","form_of","ipa","senses":[{pos,gloss,example,syn}]} or None."""
    con = _connect()
    word = _normalize(text)
    if con is None or not word or len(word) > 40:
        return None

    def has(lemma: str) -> bool:
        return con.execute("SELECT 1 FROM senses WHERE word=? LIMIT 1", (lemma,)).fetchone() is not None

    lemma = None
    if has(word):
        lemma = word
    if lemma is None:
        for (cand,) in con.execute("SELECT lemma FROM exc WHERE form=?", (word,)):
            if has(cand):
                lemma = cand
                break
    if lemma is None:
        for cand in _candidates(word):
            if has(cand):
                lemma = cand
                break
    if lemma is None:
        return None

    rows = con.execute(
        "SELECT pos, gloss, example, syn FROM senses WHERE word=? "
        "ORDER BY CASE pos WHEN 'n' THEN 0 WHEN 'v' THEN 1 WHEN 'a' THEN 2 ELSE 3 END, rank",
        (lemma,),
    ).fetchall()
    senses = [{"pos": p, "gloss": g, "example": e or "", "syn": s or ""} for p, g, e, s in rows[:max_senses]]

    ipa = ""
    for key in (word, lemma):
        row = con.execute("SELECT ipa FROM pron WHERE word=?", (key,)).fetchone()
        if row:
            ipa = row[0]
            break

    return {"word": lemma, "form_of": lemma if lemma != word else "", "ipa": ipa, "senses": senses}


def format_for_card(res: dict, typed: str) -> dict:
    """Shape a lookup() result like the reader's existing lookup card expects."""
    senses = res["senses"]
    lines, used = [], 0
    by_pos = {}
    for s in senses:
        by_pos.setdefault(s["pos"], []).append(s)
    for pos, items in list(by_pos.items())[:2]:
        for s in items[:2]:
            used += 1
            lines.append(f"{used}. ({POS_ABBR.get(pos, pos)}) {s['gloss']}")
    if res["form_of"]:
        lines.insert(0, f"Form of \u201c{res['form_of']}\u201d")
    first = senses[0]
    syn = [x for x in first["syn"].split("|") if x][:4]
    if syn:
        lines.append("Synonyms: " + ", ".join(syn))
    example = next((f"\u201c{s['example']}\u201d" for s in senses if s["example"]), "")
    return {
        "title": res["word"],
        "phonetic": res["ipa"],
        "badge": f"{POS_NAMES.get(first['pos'], 'word')}",
        "body": "\n".join(lines),
        "example": example,
    }