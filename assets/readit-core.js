/* Readit core: pure logic (no DOM) shared by the reader UI and the Node tests.
   Edits are stored as an overlay on top of the parsed book, so "reset" always works
   and re-parsing a PDF never destroys your fixes. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ReaditCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const collapse = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const normKey = (t) => collapse(t).toLowerCase().replace(/\d+/g, "#");
  const sig = (t) => collapse(t).toLowerCase().slice(0, 48);
  const emptyEdits = () => ({ v: 1, global: {}, blocks: {}, rules: [] });
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function joinText(a, b, type) {
    a = String(a || "");
    b = String(b || "");
    if (!a) return b;
    if (!b) return a;
    if (type === "lines") return a + "\n" + b;
    if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
    return a.replace(/\s+$/, "") + " " + b.replace(/^\s+/, "");
  }

  /* Find which block an edit belongs to. Normally ids are stable; after a re-parse the
     ids may shift, so we look for the same opening text nearby. Returns an index or -1. */
  function resolveIndex(blocks, id, entrySig) {
    const at = blocks[id];
    if (at && (entrySig == null || sig(at.text) === entrySig)) return id;
    if (entrySig == null) return -1;
    for (let d = 1; d <= 60; d++) {
      for (const i of [id - d, id + d]) {
        const b = blocks[i];
        if (b && sig(b.text) === entrySig) return i;
      }
    }
    return -1;
  }

function applyEdits(blocks, edits) {
    edits = edits && typeof edits === "object" ? edits : emptyEdits();
    const byIdx = new Map();
    for (const [key, entry] of Object.entries(edits.blocks || {})) {
      const idx = resolveIndex(blocks, Number(key), entry && entry.sig);
      if (idx >= 0) byIdx.set(idx, entry);
    }
    const ruleKeys = new Set((edits.rules || []).map((r) => r.key));
    const out = [];

    blocks.forEach((orig, idx) => {
      const entry = byIdx.get(idx) || null;

      // Render blocks inserted BEFORE this block
      if (entry && Array.isArray(entry.before)) {
        const len = entry.before.length;
        entry.before.forEach((seg, i) => {
          out.push({
            id: Number((orig.id - (len - i) / 1000).toFixed(3)),
            type: seg.type || "p",
            text: seg.text || "",
            pg: orig.pg,
            marker: seg.marker || orig.marker,
            _inserted: true,
            _pos: "before",
            _parent: orig.id,
            _k: i,
            mt: seg.mt, mb: seg.mb, indent: seg.indent, align: seg.align,
          });
        });
      }

      if (entry && entry.del) return;
      if (orig.type !== "img" && ruleKeys.size && ruleKeys.has(normKey(orig.text))) return;

      const blk = Object.assign({}, orig);
      blk._orig = { type: orig.type, text: orig.text };

      if (entry) {
        if (typeof entry.text === "string") blk.text = entry.text;
        if (entry.type) {
          blk.type = entry.type;
          if (entry.type === "li" && !blk.marker) blk.marker = "\u2022";
        }
        for (const f of ["mt", "mb", "indent", "align"]) {
          if (entry[f] !== undefined && entry[f] !== null) blk[f] = entry[f];
        }
      }

      if (entry && entry.mergeUp) {
        const prev = out[out.length - 1];
        const mergeable = (b) => b && b.type !== "img" && b.type !== "toc";
        if (mergeable(prev) && mergeable(blk)) {
          prev.text = joinText(prev.text, blk.text, prev.type);
          return;
        }
      }

      out.push(blk);

      // Render blocks inserted AFTER this block
      if (entry && Array.isArray(entry.after)) {
        entry.after.forEach((seg, i) => {
          out.push({
            id: Number((blk.id + (i + 1) / 1000).toFixed(3)),
            type: seg.type || blk.type,
            text: seg.text || "",
            pg: blk.pg,
            marker: seg.marker || blk.marker,
            _inserted: true,
            _pos: "after",
            _parent: blk.id,
            _k: i,
            mt: seg.mt, mb: seg.mb, indent: seg.indent, align: seg.align,
          });
        });
      }
    });
    return out;
  }

  /* Page number -> index of the first rendered block on (or after) that page. */
  function pageStarts(blocks, pageCount) {
    const n = Math.max(0, pageCount | 0);
    const starts = new Array(n).fill(-1);
    blocks.forEach((b, i) => {
      const p = b.pg;
      if (Number.isInteger(p) && p >= 0 && p < n && starts[p] === -1) starts[p] = i;
    });
    let next = Math.max(0, blocks.length - 1);
    for (let p = n - 1; p >= 0; p--) {
      if (starts[p] === -1) starts[p] = next;
      else next = starts[p];
    }
    return starts;
  }

  /* Blocks may have been deleted/merged: pick the closest surviving block id >= wanted. */
  function nearestSurvivingId(blocks, wanted) {
    if (!blocks.length) return 0;
    for (const b of blocks) if (b.id >= wanted) return b.id;
    return blocks[blocks.length - 1].id;
  }

  /* Find where a saved quote sits inside a block's text. Returns [start, end) or null. */
  function locateQuote(text, quote) {
    const q = collapse(quote).slice(0, 200);
    if (!q) return null;
    let collapsed = "";
    const map = [];
    let prevSpace = true;
    const src = String(text || "");
    for (let i = 0; i < src.length; i++) {
      const isSpace = /\s/.test(src[i]);
      if (isSpace) {
        if (prevSpace) continue;
        collapsed += " ";
        map.push(i);
        prevSpace = true;
      } else {
        collapsed += src[i];
        map.push(i);
        prevSpace = false;
      }
    }
    let at = collapsed.indexOf(q);
    let len = q.length;
    if (at < 0 && q.length > 40) {
      at = collapsed.indexOf(q.slice(0, 40));
      len = 40;
    }
    if (at < 0) return null;
    const start = map[at];
    const end = map[Math.min(at + len - 1, map.length - 1)] + 1;
    return [start, end];
  }

  function sortBookmarks(list) {
    return list.slice().sort((a, b) => a.block_id - b.block_id || (a.offset || 0) - (b.offset || 0));
  }

  function createHistory(limit) {
    const cap = limit || 60;
    const past = [];
    const future = [];
    return {
      record(snapshot) {
        past.push(snapshot);
        if (past.length > cap) past.shift();
        future.length = 0;
      },
      undo(current) {
        if (!past.length) return null;
        future.push(current);
        return past.pop();
      },
      redo(current) {
        if (!future.length) return null;
        past.push(current);
        return future.pop();
      },
      canUndo: () => past.length > 0,
      canRedo: () => future.length > 0,
      clear() {
        past.length = 0;
        future.length = 0;
      },
    };
  }

  return {
    collapse, normKey, sig, emptyEdits, uid, joinText,
    applyEdits, pageStarts, nearestSurvivingId, locateQuote, sortBookmarks, createHistory,
  };
});