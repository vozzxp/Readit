#!/usr/bin/env python3
"""
One-time setup for Readit's offline dictionary.

Downloads two free datasets and builds a single SQLite file the app reads instantly:
  * Princeton WordNet 3.0   (definitions, examples, synonyms)    - WordNet licence
  * CMU Pronouncing Dictionary (pronunciation, converted to IPA)  - BSD-style licence

Usage:
    python3 setup_dictionary.py                # download + build
    python3 setup_dictionary.py --force        # rebuild even if it already exists
    python3 setup_dictionary.py --no-pron      # skip pronunciations
    python3 setup_dictionary.py --wordnet-dir ~/Downloads/dict   # use files you already have

Output: ~/.local/share/readit/dictionary.sqlite  (about 25-35 MB)
"""
import argparse
import io
import os
import re
import sqlite3
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

DB_PATH = Path.home() / ".local" / "share" / "readit" / "dictionary.sqlite"

WORDNET_URLS = [
    "https://wordnetcode.princeton.edu/3.0/WNdb-3.0.tar.gz",
    "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip",
]
CMU_URLS = [
    "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict",
    "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/cmudict.zip",
]

POS_FILES = {"n": "noun", "v": "verb", "a": "adj", "r": "adv"}
NEEDED = (
    [f"data.{n}" for n in POS_FILES.values()]
    + [f"index.{n}" for n in POS_FILES.values()]
    + [f"{n}.exc" for n in POS_FILES.values()]
)


# ----------------------------------------------------------------------
# Download helpers
# ----------------------------------------------------------------------
def download(urls, label):
    last_error = None
    for url in urls:
        try:
            print(f"  Downloading {label} from {url}")
            req = urllib.request.Request(url, headers={"User-Agent": "Readit-dictionary-setup/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                total = int(resp.headers.get("Content-Length") or 0)
                buf = io.BytesIO()
                done = 0
                while True:
                    chunk = resp.read(1 << 16)
                    if not chunk:
                        break
                    buf.write(chunk)
                    done += len(chunk)
                    if total:
                        print(f"\r    {done / 1e6:5.1f} / {total / 1e6:.1f} MB", end="", flush=True)
                print()
                return url, buf.getvalue()
        except Exception as e:  # try the next mirror
            last_error = e
            print(f"    failed: {e}")
    raise RuntimeError(f"Could not download {label}: {last_error}")


def extract_wordnet(url, blob):
    """Return {filename: text} for the WordNet files we need, from a .tar.gz or .zip."""
    files = {}
    if url.endswith(".zip") or blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            for name in z.namelist():
                base = os.path.basename(name)
                if base in NEEDED:
                    files[base] = z.read(name).decode("utf-8", errors="replace")
    else:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as t:
            for m in t.getmembers():
                base = os.path.basename(m.name)
                if m.isfile() and base in NEEDED:
                    files[base] = t.extractfile(m).read().decode("utf-8", errors="replace")
    return files


def read_wordnet_dir(path):
    files = {}
    for name in NEEDED:
        p = Path(path).expanduser() / name
        if p.is_file():
            files[name] = p.read_text(encoding="utf-8", errors="replace")
    return files


# ----------------------------------------------------------------------
# WordNet parsing
# ----------------------------------------------------------------------
def parse_data(text):
    """offset -> (words, definition, first_example)"""
    synsets = {}
    for line in text.splitlines():
        if not line or line[0] == " ":  # licence header
            continue
        head, _, gloss = line.partition("|")
        t = head.split()
        if len(t) < 6:
            continue
        w_cnt = int(t[3], 16)
        words = [re.sub(r"\(\w+\)$", "", t[4 + 2 * i]).replace("_", " ") for i in range(w_cnt)]
        gloss = gloss.strip()
        m = re.search(r';\s*"', gloss)
        definition = gloss[: m.start()] if m else gloss
        examples = re.findall(r'"([^"]+)"', gloss[m.start():]) if m else []
        synsets[t[0]] = (words, definition.strip(), examples[0] if examples else "")
    return synsets


def parse_index(text):
    """Yield (lemma, [synset offsets in frequency order])."""
    for line in text.splitlines():
        if not line or line[0] == " ":
            continue
        t = line.split()
        if len(t) < 6:
            continue
        synset_cnt = int(t[2])
        p_cnt = int(t[3])
        idx = 4 + p_cnt + 2  # skip pointer symbols, sense_cnt, tagsense_cnt
        yield t[0].replace("_", " "), t[idx: idx + synset_cnt]


def parse_exc(text):
    for line in text.splitlines():
        t = line.split()
        if len(t) >= 2:
            form = t[0].replace("_", " ")
            for lemma in t[1:]:
                yield form, lemma.replace("_", " ")


# ----------------------------------------------------------------------
# CMU pronouncing dictionary -> IPA
# ----------------------------------------------------------------------
VOWELS = {"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"}
IPA = {
    "AA": "ɑ", "AE": "æ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ", "B": "b", "CH": "tʃ", "D": "d",
    "DH": "ð", "EH": "ɛ", "EY": "eɪ", "F": "f", "G": "ɡ", "HH": "h", "IH": "ɪ", "IY": "i",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ", "OW": "oʊ", "OY": "ɔɪ",
    "P": "p", "R": "ɹ", "S": "s", "SH": "ʃ", "T": "t", "TH": "θ", "UH": "ʊ", "UW": "u",
    "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}
ONSETS2 = {
    ("P", "R"), ("P", "L"), ("P", "Y"), ("B", "R"), ("B", "L"), ("B", "Y"), ("T", "R"), ("T", "W"),
    ("D", "R"), ("D", "W"), ("K", "R"), ("K", "L"), ("K", "W"), ("K", "Y"), ("G", "R"), ("G", "L"),
    ("G", "W"), ("F", "R"), ("F", "L"), ("F", "Y"), ("V", "Y"), ("TH", "R"), ("TH", "W"), ("SH", "R"),
    ("S", "P"), ("S", "T"), ("S", "K"), ("S", "M"), ("S", "N"), ("S", "L"), ("S", "W"), ("S", "F"),
    ("HH", "Y"), ("M", "Y"), ("N", "Y"), ("L", "Y"), ("S", "Y"),
}
ONSETS3 = {
    ("S", "P", "R"), ("S", "T", "R"), ("S", "K", "R"), ("S", "P", "L"), ("S", "K", "W"),
    ("S", "P", "Y"), ("S", "T", "Y"), ("S", "K", "Y"),
}


def arpa_to_ipa(phones):
    toks = []
    for p in phones:
        m = re.match(r"([A-Z]+)([012])?$", p)
        if m:
            toks.append((m.group(1), m.group(2)))
    if not toks:
        return ""
    n_vowels = sum(1 for b, _ in toks if b in VOWELS)

    marks = {}
    if n_vowels > 1:  # one-syllable words get no stress mark
        for i, (base, stress) in enumerate(toks):
            if base in VOWELS and stress in ("1", "2"):
                j = i
                while j > 0 and toks[j - 1][0] not in VOWELS:
                    j -= 1
                start = i
                for k in (3, 2, 1):
                    if i - k >= j:
                        cluster = tuple(b for b, _ in toks[i - k: i])
                        if (k == 1 and cluster[0] != "NG") or (k == 2 and cluster in ONSETS2) or (k == 3 and cluster in ONSETS3):
                            start = i - k
                            break
                marks[start] = "ˈ" if stress == "1" else "ˌ"

    out = []
    for i, (base, stress) in enumerate(toks):
        if i in marks:
            out.append(marks[i])
        if base == "AH":
            out.append("ə" if stress in (None, "0") else "ʌ")
        elif base == "ER":
            out.append("ɚ" if stress in (None, "0") else "ɝ")
        else:
            out.append(IPA.get(base, ""))
    return "/" + "".join(out) + "/"


def parse_cmu(text):
    seen = set()
    for line in text.splitlines():
        if not line or line.startswith(";;;"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        word = re.sub(r"\(\d+\)$", "", parts[0]).lower()
        if word in seen or not re.match(r"^[a-z][a-z'.\-]*$", word):
            continue
        seen.add(word)
        ipa = arpa_to_ipa(parts[1:])
        if ipa:
            yield word, ipa


# ----------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------
def build_database(files, cmu_text, out_path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".building")
    if tmp.exists():
        tmp.unlink()

    con = sqlite3.connect(tmp)
    con.executescript(
        """
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE senses(word TEXT NOT NULL, pos TEXT NOT NULL, rank INTEGER NOT NULL,
                            gloss TEXT NOT NULL, example TEXT, syn TEXT);
        CREATE TABLE exc(form TEXT NOT NULL, pos TEXT NOT NULL, lemma TEXT NOT NULL);
        CREATE TABLE pron(word TEXT PRIMARY KEY, ipa TEXT NOT NULL) WITHOUT ROWID;
        """
    )

    n_senses = 0
    for pos, name in POS_FILES.items():
        data_txt, index_txt = files.get(f"data.{name}"), files.get(f"index.{name}")
        if not data_txt or not index_txt:
            raise RuntimeError(f"Missing WordNet file for '{name}'")
        synsets = parse_data(data_txt)
        rows = []
        for lemma, offsets in parse_index(index_txt):
            for rank, off in enumerate(offsets):
                syn = synsets.get(off)
                if not syn:
                    continue
                words, definition, example = syn
                others = "|".join(w for w in words if w.lower() != lemma.lower())
                rows.append((lemma.lower(), pos, rank, definition, example, others))
        con.executemany("INSERT INTO senses VALUES (?,?,?,?,?,?)", rows)
        n_senses += len(rows)
        print(f"  {name:<5} {len(rows):>7} senses")

        exc_txt = files.get(f"{name}.exc")
        if exc_txt:
            con.executemany("INSERT INTO exc VALUES (?,?,?)", [(f.lower(), pos, l.lower()) for f, l in parse_exc(exc_txt)])

    n_pron = 0
    if cmu_text:
        con.executemany("INSERT OR IGNORE INTO pron VALUES (?,?)", parse_cmu(cmu_text))
        n_pron = con.execute("SELECT COUNT(*) FROM pron").fetchone()[0]
        print(f"  pronunciations: {n_pron}")

    print("  Indexing...")
    con.executescript(
        """
        CREATE INDEX idx_senses_word ON senses(word, pos, rank);
        CREATE INDEX idx_exc_form ON exc(form);
        """
    )
    con.executemany(
        "INSERT INTO meta VALUES (?,?)",
        [
            ("source", "Princeton WordNet 3.0 + CMU Pronouncing Dictionary"),
            ("built", time.strftime("%Y-%m-%d")),
            ("senses", str(n_senses)),
            ("pronunciations", str(n_pron)),
        ],
    )
    con.commit()
    con.execute("VACUUM")
    con.close()
    os.replace(tmp, out_path)
    return n_senses, n_pron


def main():
    ap = argparse.ArgumentParser(description="Build Readit's offline dictionary.")
    ap.add_argument("--force", action="store_true", help="rebuild even if the database exists")
    ap.add_argument("--no-pron", action="store_true", help="skip pronunciations")
    ap.add_argument("--wordnet-dir", help="folder that already contains WordNet's data.* / index.* files")
    ap.add_argument("--cmu-file", help="path to an existing cmudict.dict file")
    ap.add_argument("--out", default=str(DB_PATH), help=f"output path (default: {DB_PATH})")
    args = ap.parse_args()
    out = Path(args.out).expanduser()

    if out.exists() and not args.force:
        print(f"Dictionary already exists at {out}\nUse --force to rebuild it.")
        return 0

    print("1/3  WordNet")
    if args.wordnet_dir:
        files = read_wordnet_dir(args.wordnet_dir)
    else:
        url, blob = download(WORDNET_URLS, "WordNet 3.0")
        files = extract_wordnet(url, blob)
    missing = [n for n in NEEDED if n not in files and not n.endswith(".exc")]
    if missing:
        print("Missing WordNet files:", ", ".join(missing))
        return 1

    cmu_text = ""
    print("2/3  Pronunciations")
    if args.no_pron:
        print("  skipped")
    else:
        try:
            if args.cmu_file:
                cmu_text = Path(args.cmu_file).expanduser().read_text(encoding="utf-8", errors="replace")
            else:
                url, blob = download(CMU_URLS, "CMU Pronouncing Dictionary")
                if url.endswith(".zip"):
                    with zipfile.ZipFile(io.BytesIO(blob)) as z:
                        name = next(n for n in z.namelist() if os.path.basename(n).lower().startswith("cmudict") and not n.endswith("/"))
                        cmu_text = z.read(name).decode("utf-8", errors="replace")
                else:
                    cmu_text = blob.decode("utf-8", errors="replace")
        except Exception as e:
            print(f"  Pronunciations unavailable ({e}); continuing without them.")

    print("3/3  Building database")
    n_senses, n_pron = build_database(files, cmu_text, out)
    size_mb = out.stat().st_size / 1e6
    print(f"\nDone: {n_senses} senses, {n_pron} pronunciations, {size_mb:.1f} MB -> {out}")
    print("WordNet (c) Princeton University; CMUdict (c) Carnegie Mellon University.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
