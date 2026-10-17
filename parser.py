import os
import re
import json
import shutil
import hashlib
from collections import defaultdict
from pathlib import Path
from statistics import median

try:
    import pymupdf as fitz
except ImportError:
    import fitz  # Fallback for older PyMuPDF releases


# Bump this whenever the reflow logic changes. Books imported with an older
# version are re-parsed automatically the next time you open them.
PARSER_VERSION = 4  # v4: every block records its PDF page ("pg")

DATA_DIR = Path.home() / ".local" / "share" / "readit"
BOOKS_DIR = DATA_DIR / "books"
LIBRARY_FILE = DATA_DIR / "library.json"
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULT_SETTINGS = {
    "theme": "gnome-dark",
    "font_family": "literata",
    "font_size": 19,
    "line_height": 1.75,
    "max_width": 64,
    "warmth": 0,
    "saturation": 100,
    "colorful_images": False,
    "fast_reading": False,
    "fast_strength": 2,  # 1 = subtle, 2 = balanced, 3 = strong
}


# ----------------------------------------------------------------------
# Storage helpers
# ----------------------------------------------------------------------
def ensure_dirs():
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)


def load_settings() -> dict:
    ensure_dirs()
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return {**DEFAULT_SETTINGS, **data}
        except Exception:
            pass
    return DEFAULT_SETTINGS.copy()


def save_settings(new_settings: dict) -> dict:
    ensure_dirs()
    current = load_settings()
    current.update(new_settings)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2)
    return current


def load_library() -> dict:
    ensure_dirs()
    if LIBRARY_FILE.exists():
        try:
            with open(LIBRARY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_library(library: dict):
    ensure_dirs()
    with open(LIBRARY_FILE, "w", encoding="utf-8") as f:
        json.dump(library, f, indent=2)


def update_reading_progress(book_id: str, block_id: int, offset: float, progress_pct: float):
    library = load_library()
    if book_id in library:
        library[book_id]["current_block"] = int(block_id)
        library[book_id]["current_offset"] = round(float(offset), 4)
        library[book_id]["progress_pct"] = round(float(progress_pct), 1)
        save_library(library)


def remove_book(book_id: str):
    library = load_library()
    if book_id in library:
        del library[book_id]
        save_library(library)
    book_dir = BOOKS_DIR / book_id
    if book_dir.exists():
        shutil.rmtree(book_dir, ignore_errors=True)


# ----------------------------------------------------------------------
# Per-book user data: bookmarks + manual edits (kept apart from the parsed text,
# so re-parsing a book never wipes your fixes)
# ----------------------------------------------------------------------
def _userdata_path(book_id: str) -> Path:
    return BOOKS_DIR / book_id / "userdata.json"


def load_userdata(book_id: str) -> dict:
    default = {"bookmarks": [], "edits": {}}
    path = _userdata_path(book_id)
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return {
                    "bookmarks": data.get("bookmarks") if isinstance(data.get("bookmarks"), list) else [],
                    "edits": data.get("edits") if isinstance(data.get("edits"), dict) else {},
                }
        except Exception:
            pass
    return default


def save_userdata(book_id: str, data: dict):
    if not book_id or not isinstance(data, dict) or not (BOOKS_DIR / book_id).exists():
        return
    clean = {
        "bookmarks": data.get("bookmarks") if isinstance(data.get("bookmarks"), list) else [],
        "edits": data.get("edits") if isinstance(data.get("edits"), dict) else {},
    }
    path = _userdata_path(book_id)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(clean, f, ensure_ascii=False)
    os.replace(tmp, path)


def needs_reparse(book: dict) -> bool:
    """True when the book was imported by an older parser and the PDF still exists."""
    if int(book.get("parser_version", 1)) >= PARSER_VERSION:
        return False
    return Path(book.get("filepath", "")).is_file()


def _compute_file_hash(filepath: str) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()[:16]


# ----------------------------------------------------------------------
# Text heuristics
# ----------------------------------------------------------------------
ROMAN_RE = r"(?=[ivxlcdm]+$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})"

TOC_LINE_RE = re.compile(
    r"^(?P<title>.*?\S)(?:\s*[.\u00b7\u2022\u2026_\-\u2013]{2,}\s*|\s+)"
    r"(?P<page>\d{1,4}|" + ROMAN_RE + r")$"
)
TOC_TITLE_RE = re.compile(r"^(table of\s+)?contents$", re.IGNORECASE)
CHAPTER_RE = re.compile(r"^(part|chapter|appendix|section)\b|^\d+[.:]\s", re.IGNORECASE)

GLYPH_BULLET_RE = re.compile(r"^([\u2022\u2023\u25aa\u25cf\u25cb\u25e6\u25a0\u25ba\u00b7\u2043*]|[-\u2013\u2014])\s+")
NUM_BULLET_RE = re.compile(r"^(\(?\d{1,2}[.)]|\(?[a-zA-Z][.)])\s+")


def _is_page_number_or_noise(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    if re.match(r"^(page\s*)?\d+(\s*(of|/)\s*\d+)?$", stripped, re.IGNORECASE):
        return True
    if re.match(r"^[ivxlcdm]+$", stripped, re.IGNORECASE) and len(stripped) <= 6:
        return True
    return False


def _toc_parts(text: str):
    """Return (title, page) if the line looks like a contents entry, else None."""
    if len(text) > 140:
        return None
    m = TOC_LINE_RE.match(text.strip())
    if not m:
        return None
    title = m.group("title").strip(" .\u00b7\u2022\u2026_-\u2013")
    if len(title) < 2 or re.fullmatch(r"[\d\s.,]+", title):
        return None
    return title, m.group("page")


def _span_is_bold(span: dict) -> bool:
    if span.get("flags", 0) & 16:
        return True
    font = (span.get("font") or "").lower()
    return any(k in font for k in ("bold", "black", "heavy", "semibold", "demi"))


def _extract_lines(block: dict) -> list:
    """Flatten a PyMuPDF text block into clean line dicts (text, size, bold, bbox)."""
    out = []
    for line in block.get("lines", []):
        parts = []
        sizes = []
        chars = 0
        bold_chars = 0
        prev_x1 = None
        for span in line.get("spans", []):
            txt = span.get("text", "")
            if not txt.strip():
                parts.append(txt)
                continue
            size = span.get("size", 11.0)
            sx0, _, sx1, _ = span.get("bbox", (0, 0, 0, 0))
            if (
                parts
                and prev_x1 is not None
                and (sx0 - prev_x1) > size * 0.3
                and not parts[-1].endswith(" ")
                and not txt.startswith(" ")
            ):
                parts.append(" ")
            parts.append(txt)
            prev_x1 = sx1
            n = len(txt.strip())
            chars += n
            sizes.append(size)
            if _span_is_bold(span):
                bold_chars += n

        text = re.sub(r"\s+", " ", "".join(parts)).strip()
        if not text:
            continue
        x0, y0, x1, y1 = line.get("bbox", (0, 0, 0, 0))
        out.append({
            "text": text,
            "size": median(sizes) if sizes else 11.0,
            "bold": chars > 0 and (bold_chars / chars) >= 0.6,
            "x0": x0, "y0": y0, "x1": x1, "y1": y1,
        })
    return out


def _join_texts(texts: list) -> str:
    """Join wrapped lines into one paragraph, repairing soft-hyphenated words."""
    out = ""
    for t in texts:
        if not out:
            out = t
        elif out.endswith("-") and len(out) > 1 and out[-2].isalpha() and t[:1].islower():
            out = out[:-1] + t
        else:
            out += " " + t
    return re.sub(r"\s+", " ", out).strip()


def _cluster_rows(lines: list) -> list:
    """Merge lines that sit on the same visual row."""
    ordered = sorted(lines, key=lambda l: ((l["y0"] + l["y1"]) / 2, l["x0"]))
    rows = []
    for ln in ordered:
        yc = (ln["y0"] + ln["y1"]) / 2
        height = max(ln["y1"] - ln["y0"], 6.0)
        if rows and abs(yc - rows[-1]["yc"]) <= 0.55 * height:
            rows[-1]["items"].append(ln)
        else:
            rows.append({"yc": yc, "items": [ln]})

    merged = []
    for r in rows:
        items = sorted(r["items"], key=lambda l: l["x0"])
        merged.append({
            "text": re.sub(r"\s+", " ", " ".join(i["text"] for i in items)).strip(),
            "bold": items[0]["bold"],
            "size": items[0]["size"],
            "x0": items[0]["x0"],
            "x1": max(i["x1"] for i in items),
            "y0": min(i["y0"] for i in items),
            "y1": max(i["y1"] for i in items),
        })
    return merged


def _estimate_body_font_size(doc) -> float:
    sizes = []
    sample_pages = min(len(doc), 25)
    for idx in range(sample_pages):
        page_dict = doc[idx].get_text("dict")
        for block in page_dict.get("blocks", []):
            if block.get("type") == 0:
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        txt = span.get("text", "").strip()
                        if len(txt) > 20:
                            sizes.append(round(span.get("size", 11.0), 1))
    return median(sizes) if sizes else 11.0


def _norm_key(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"\d+", "#", text.lower())).strip()


_ROMAN_FULL = re.compile(r"m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})", re.IGNORECASE)


def _is_pageno_token(tok: str) -> bool:
    if re.fullmatch(r"\d{1,4}", tok):
        return True
    if len(tok) > 6 or not tok.isalpha() or not _ROMAN_FULL.fullmatch(tok):
        return False
    return tok.islower() or len(tok) >= 2


def _has_pageno_edge(text: str) -> bool:
    words = text.split()
    if not (2 <= len(words) <= 6) or len(text) > 60 or re.search(r"[.!?,;:]$", text):
        return False
    if re.match(r"^(chapter|part|section|appendix|figure|table)\b", text, re.IGNORECASE):
        return False
    return _is_pageno_token(words[0]) or _is_pageno_token(words[-1])


# ----------------------------------------------------------------------
# Block classification
# ----------------------------------------------------------------------
def _heading_tag(size: float, bold: bool, text: str, body_size: float, n_lines: int):
    if n_lines > 4 or len(text) > 180:
        return None
    if size >= body_size * 1.42:
        return "h1"
    if size >= body_size * 1.16 or (bold and len(text) < 95 and not text.endswith(".")):
        return "h2"
    return None


def _block_to_elements(lines: list, body_size: float) -> list:
    """Turn one PDF text block into reader elements, keeping structure that matters."""
    lines = _cluster_rows(lines)
    n = len(lines)
    size = median([l["size"] for l in lines])
    bold = sum(1 for l in lines if l["bold"]) >= 0.7 * n
    full = _join_texts([l["text"] for l in lines])

    tag = _heading_tag(size, bold, full, body_size, n)
    if tag:
        return [{"type": tag, "text": full}]

    if n == 1:
        return [{"type": "p", "text": full}]

    hits = [_toc_parts(l["text"]) for l in lines]
    if sum(1 for h in hits if h) >= 0.6 * n:
        out = []
        for l, h in zip(lines, hits):
            if h:
                out.append({"type": "toc", "text": h[0], "page": h[1], "level": 1 if l["bold"] else 2})
            else:
                out.append({"type": "toc", "text": l["text"], "page": "", "level": 1 if l["bold"] else 2})
        return out

    glyph_marks = [bool(GLYPH_BULLET_RE.match(l["text"])) for l in lines]
    num_marks = [bool(NUM_BULLET_RE.match(l["text"])) for l in lines]
    use_glyph = glyph_marks[0]
    use_num = (not use_glyph) and num_marks[0] and sum(num_marks) >= 2
    if use_glyph or use_num:
        regex = GLYPH_BULLET_RE if use_glyph else NUM_BULLET_RE
        items = []
        for l in lines:
            m = regex.match(l["text"])
            if m:
                marker = "\u2022" if use_glyph else m.group(1)
                items.append({"marker": marker, "texts": [l["text"][m.end():]]})
            elif items:
                items[-1]["texts"].append(l["text"])
            else:
                items.append({"marker": "", "texts": [l["text"]]})
        return [
            {"type": "li", "marker": it["marker"], "text": _join_texts(it["texts"])}
            for it in items
        ]

    widths = [l["x1"] - l["x0"] for l in lines]
    max_w = max(widths) if widths else 1.0
    short = sum(1 for w in widths[:-1] if w < 0.68 * max_w)
    if short >= max(1, round(0.34 * (n - 1))):
        return [{"type": "lines", "text": "\n".join(l["text"] for l in lines)}]

    return [{"type": "p", "text": full}]


def _zone_of(y0: float, y1: float, page_h: float, text: str) -> str:
    if len(text) >= 110:
        return ""
    if y0 <= page_h * 0.12:
        return "head"
    if y1 >= page_h * 0.88:
        return "foot"
    return ""


def _toc_page_elements(rows: list, body_size: float, page_h: float, prev_toc: bool) -> list:
    parsed = [(_toc_parts(r["text"]), r) for r in rows]
    matching = [r for p, r in parsed if p]
    any_bold = any(r["bold"] for r in matching)
    min_x0 = min((r["x0"] for r in matching), default=0.0)
    first_run = not prev_toc
    seen_bold = False
    elements = []

    for parts, r in parsed:
        zone = _zone_of(r["y0"], r["y1"], page_h, r["text"])
        if parts:
            title, page = parts
            if r["bold"]:
                seen_bold = True
            chapter = bool(CHAPTER_RE.match(title))
            if any_bold:
                level = 1 if (r["bold"] or chapter or (first_run and not seen_bold)) else 2
            else:
                level = 1 if (chapter or (r["x0"] - min_x0) < 6) else 2
            elements.append({"type": "toc", "text": title, "page": page, "level": level,
                             "y0": r["y0"], "x0": r["x0"], "zone": ""})
            continue

        tag = _heading_tag(r["size"], r["bold"], r["text"], body_size, 1)
        if tag:
            elements.append({"type": tag, "text": r["text"], "y0": r["y0"], "x0": r["x0"], "zone": zone})
        elif zone:
            elements.append({"type": "p", "text": r["text"], "y0": r["y0"], "x0": r["x0"], "zone": zone})
        else:
            elements.append({"type": "toc", "text": r["text"], "page": "",
                             "level": 1 if r["bold"] else 2,
                             "y0": r["y0"], "x0": r["x0"], "zone": ""})
    return elements


# ----------------------------------------------------------------------
# Import
# ----------------------------------------------------------------------
def import_pdf(pdf_path: str, force: bool = False) -> dict:
    ensure_dirs()
    pdf_path = os.path.abspath(pdf_path)
    book_id = _compute_file_hash(pdf_path)
    book_dir = BOOKS_DIR / book_id
    images_dir = book_dir / "images"
    blocks_file = book_dir / "blocks.json"

    library = load_library()
    existing = library.get(book_id)
    if (
        existing
        and blocks_file.exists()
        and not force
        and int(existing.get("parser_version", 1)) >= PARSER_VERSION
    ):
        return existing

    shutil.rmtree(images_dir, ignore_errors=True)
    images_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    total_pages = max(len(doc), 1)

    meta = doc.metadata or {}
    title = (meta.get("title") or "").strip()
    if not title or title.lower() == "untitled":
        title = Path(pdf_path).stem.replace("_", " ").replace("-", " ")
    author = (meta.get("author") or "").strip()

    cover_path = book_dir / "cover.png"
    if len(doc) > 0:
        first_page = doc[0]
        zoom = 300.0 / max(first_page.rect.width, 1.0)
        pix = first_page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        pix.save(str(cover_path))

    body_size = _estimate_body_font_size(doc)
    dict_flags = fitz.TEXTFLAGS_DICT | fitz.TEXT_PRESERVE_IMAGES

    raw_items = []
    img_counter = 0
    prev_toc = False

    for page_index, page in enumerate(doc):
        page_h = max(page.rect.height, 1.0)
        page_w = max(page.rect.width, 1.0)
        hard_head = page_h * 0.068
        hard_foot = page_h * 0.932

        page_dict = page.get_text("dict", flags=dict_flags)
        text_blocks = []
        image_elements = []

        for block in page_dict.get("blocks", []):
            btype = block.get("type")
            x0, y0, x1, y1 = block.get("bbox", (0, 0, 0, 0))

            if btype == 0:
                lines = _extract_lines(block)
                if not lines:
                    continue
                joined = " ".join(l["text"] for l in lines)
                if _is_page_number_or_noise(joined):
                    continue
                if (y1 <= hard_head or y0 >= hard_foot) and len(joined) < 110:
                    continue
                text_blocks.append({
                    "lines": lines, "y0": y0, "x0": x0,
                    "zone": _zone_of(y0, y1, page_h, joined),
                })

            elif btype == 1:
                img_bytes = block.get("image")
                if not img_bytes:
                    continue
                try:
                    pix = fitz.Pixmap(img_bytes)
                    if pix.width < 55 or pix.height < 55:
                        continue
                    if (x1 - x0) < (page_w * 0.08) and (y1 - y0) < (page_h * 0.05):
                        continue
                    if pix.n - pix.alpha > 3:
                        pix = fitz.Pixmap(fitz.csRGB, pix)

                    img_filename = f"img_{page_index}_{img_counter}.png"
                    img_path = images_dir / img_filename
                    pix.save(str(img_path))
                    img_counter += 1
                    image_elements.append({
                        "y0": y0, "x0": x0, "type": "img", "zone": "",
                        "src": img_path.as_uri(), "width": pix.width, "height": pix.height,
                    })
                except Exception:
                    continue

        page_elements = []
        all_lines = [l for b in text_blocks for l in b["lines"]]
        page_is_toc = False
        rows = []
        if all_lines:
            rows = _cluster_rows(all_lines)
            hits = sum(1 for r in rows if _toc_parts(r["text"]))
            ratio = hits / max(len(rows), 1)
            has_title = any(TOC_TITLE_RE.match(r["text"]) for r in rows)
            page_is_toc = (
                (hits >= 5 and ratio >= 0.45)
                or (prev_toc and hits >= 3 and ratio >= 0.30)
                or (has_title and hits >= 3 and ratio >= 0.30)
            )

        if page_is_toc:
            page_elements.extend(_toc_page_elements(rows, body_size, page_h, prev_toc))
        else:
            for b in text_blocks:
                for el in _block_to_elements(b["lines"], body_size):
                    el["y0"] = b["y0"]
                    el["x0"] = b["x0"]
                    el["zone"] = b["zone"]
                    page_elements.append(el)
        prev_toc = page_is_toc

        page_elements.extend(image_elements)
        for el in page_elements:
            el["_pg"] = page_index
        page_elements.sort(key=lambda it: (round(it["y0"] / 3.0), it["x0"]))
        raw_items.extend(page_elements)

    doc.close()

    zone_pages = defaultdict(set)
    for el in raw_items:
        if el.get("zone") and el["type"] in ("p", "h1", "h2"):
            zone_pages[_norm_key(el["text"])].add(el["_pg"])

    filtered = []
    seen_keys = set()
    for el in raw_items:
        if el.get("zone") and el["type"] == "p" and _has_pageno_edge(el["text"]):
            continue
        if el.get("zone") and el["type"] in ("p", "h1", "h2") and not re.search(r"[.!?]$", el["text"]):
            key = _norm_key(el["text"])
            count = len(zone_pages[key])
            if count >= 2:
                if count >= max(3, 0.25 * total_pages):
                    continue
                if el["type"] == "p":
                    continue
                if key in seen_keys:
                    continue
                seen_keys.add(key)
        filtered.append(el)

    stitched = []
    for item in filtered:
        if stitched and item["type"] == "p" and stitched[-1]["type"] == "p":
            prev_text = stitched[-1]["text"]
            curr_text = item["text"]
            prev_incomplete = not re.search(r'[.!?:;"\u201d\u2019\])]\s*$', prev_text)
            curr_continues = bool(re.match(r"^[a-z,;\u2014\u2013\-]", curr_text))
            if prev_incomplete and curr_continues:
                if prev_text.endswith("-") and len(prev_text) > 1:
                    stitched[-1]["text"] = prev_text[:-1] + curr_text
                else:
                    stitched[-1]["text"] = prev_text + " " + curr_text
                continue

        blk = {k: v for k, v in item.items() if k not in ("y0", "x0", "zone", "_pg")}
        blk["pg"] = int(item.get("_pg", 0))
        stitched.append(blk)

    for idx, blk in enumerate(stitched):
        blk["id"] = idx

    with open(blocks_file, "w", encoding="utf-8") as f:
        json.dump(stitched, f, ensure_ascii=False)

    current_block, current_offset, progress_pct = 0, 0.0, 0.0
    if existing:
        old_count = max(int(existing.get("block_count", 0)), 1)
        ratio = int(existing.get("current_block", 0)) / old_count
        current_block = int(ratio * len(stitched))
        current_offset = float(existing.get("current_offset", 0.0))
        progress_pct = float(existing.get("progress_pct", 0.0))

    book_entry = {
        "id": book_id,
        "title": title,
        "author": author,
        "filepath": pdf_path,
        "cover_path": str(cover_path) if cover_path.exists() else "",
        "blocks_file": str(blocks_file),
        "block_count": len(stitched),
        "page_count": total_pages,
        "parser_version": PARSER_VERSION,
        "current_block": current_block,
        "current_offset": current_offset,
        "progress_pct": progress_pct,
    }

    library[book_id] = book_entry
    save_library(library)
    return book_entry


def get_book_blocks(book_id: str) -> list:
    library = load_library()
    entry = library.get(book_id)
    if not entry:
        return []
    blocks_file = Path(entry["blocks_file"])
    if not blocks_file.exists():
        return []
    with open(blocks_file, "r", encoding="utf-8") as f:
        return json.load(f)