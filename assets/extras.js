/* Readit extras: 200px smooth scrollbar, page indicator + seek, bookmarks, Ctrl+F search, edit mode. */
(() => {
  "use strict";

  const Core = window.ReaditCore;
  const engine = window.ReaditEngine;
  if (!Core || !engine) {
    console.error("Readit extras: core or engine missing");
    return;
  }

  const streamEl = document.getElementById("book-stream");
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const h = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const post = (payload) => {
    const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.readit;
    if (handler) handler.postMessage(JSON.stringify(payload));
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };
  const safe = (name, fn) => {
    try {
      fn();
    } catch (e) {
      console.error(`Readit extras [${name}]:`, e);
    }
  };
  const flag = (name) => document.body.getAttribute(`data-${name}`) === "true";
  const fmt = (n) => (Math.round(n * 100) / 100).toString();

  const ICON = {
    bookmark: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    bookmarkFilled: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    chevUp: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
    chevDown: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  };

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const S = {
    book: null,
    rawBlocks: [],
    blocks: [],
    byId: new Map(),
    idToEl: new Map(),
    bmByBlock: new Map(),
    pageCount: 1,
    starts: [],
    userdata: { bookmarks: [], edits: Core.emptyEdits() },
    history: Core.createHistory(80),
    editMode: false,
    selEl: null,
    selId: null,
    typing: false,
    wasFast: false,
    panelOpen: false,
    pageInputOpen: false,
    searchOpen: false,
    afterRender: null,
  };

  const E = () => S.userdata.edits;

  function sanitizeUserdata(u) {
    const edits = u && u.edits && typeof u.edits === "object" ? u.edits : {};
    return {
      bookmarks: Array.isArray(u && u.bookmarks) ? u.bookmarks : [],
      edits: Object.assign(Core.emptyEdits(), edits, {
        blocks: edits.blocks || {},
        rules: edits.rules || [],
        global: edits.global || {},
      }),
    };
  }

  let saveTimer = null;
  function persistNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (S.book && S.book.id) post({ action: "save_userdata", userdata: S.userdata });
  }
  function persistSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 350);
  }

  let lastModal = false;
  function syncModal() {
    const modal = S.editMode || S.panelOpen || S.pageInputOpen || S.searchOpen;
    if (modal !== lastModal) {
      lastModal = modal;
      post({ action: "ui_state", modal });
    }
  }

  // ------------------------------------------------------------------
  // Geometry helpers
  // ------------------------------------------------------------------
  function blockIndexAtY(absY) {
    const kids = streamEl.children;
    let lo = 0;
    let hi = kids.length - 1;
    let ans = Math.max(0, kids.length - 1);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = kids[mid].getBoundingClientRect();
      if (r.bottom + window.scrollY > absY) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }

  function getAnchor() {
    const kids = streamEl.children;
    if (!kids.length) return { index: 0, id: 0, offset: 0, top: 0 };
    const index = blockIndexAtY(window.scrollY + 48);
    const r = kids[index].getBoundingClientRect();
    const blk = S.blocks[index];
    return {
      index,
      id: blk ? blk.id : 0,
      offset: clamp((48 - r.top) / Math.max(r.height, 1), 0, 0.99),
      top: r.top,
    };
  }

  function scrollToEl(el, extra = 0) {
    const y = window.scrollY + el.getBoundingClientRect().top - 64 + extra;
    window.scrollTo({ top: Math.max(0, y), behavior: "instant" });
  }

  function textRoot(el) {
    return el.classList.contains("li") ? el.querySelector(".li-text") || el : el;
  }

  function rangeFromOffsets(root, start, end) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let pos = 0;
    let started = false;
    let node;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (!started && start < pos + len) {
        range.setStart(node, start - pos);
        started = true;
      }
      if (started && end <= pos + len) {
        range.setEnd(node, end - pos);
        return range;
      }
      pos += len;
    }
    return null;
  }

  let flashHighlightTimer = null;

  function clearTempBookmarkMarks() {
    $$("mark.rd-bm-temp", streamEl).forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete("rd-bm-flash");
    }
  }

  function flashBookmarkTarget(el, quote) {
    clearTimeout(flashHighlightTimer);
    clearTempBookmarkMarks();

    if (quote) {
      const root = textRoot(el);
      const loc = Core.locateQuote(root.textContent, quote);
      if (loc) {
        const range = rangeFromOffsets(root, loc[0], loc[1]);
        if (range) {
          try {
            const mark = document.createElement("mark");
            mark.className = "rd-bm-temp";
            mark.appendChild(range.extractContents());
            range.insertNode(mark);
            flashHighlightTimer = setTimeout(() => {
              clearTempBookmarkMarks();
            }, 2000);
            return;
          } catch (_e) {
            // Fallback to block flash if range crosses complex nodes
          }
        }
      }
    }

    el.classList.remove("rd-flash");
    void el.offsetWidth;
    el.classList.add("rd-flash");
    flashHighlightTimer = setTimeout(() => el.classList.remove("rd-flash"), 2000);
  }

  // ------------------------------------------------------------------
  // Toast
  // ------------------------------------------------------------------
  const toastEl = h("div", "rd-toast");
  document.body.appendChild(toastEl);
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
  }

  // ------------------------------------------------------------------
  // Render pipeline
  // ------------------------------------------------------------------
  const origLoad = engine.loadBook.bind(engine);

  function applyGlobal() {
    const g = E().global || {};
    const root = document.documentElement.style;
    root.setProperty("--rd-pspace", `${g.pspace != null ? g.pspace : 1.25}em`);
    root.setProperty("--rd-pindent", `${g.pindent != null ? g.pindent : 0}em`);
  }

  function postRender() {
    const kids = streamEl.children;
    S.idToEl = new Map();
    S.byId = new Map();
    let prevPg = -1;
    S.blocks.forEach((b, i) => {
      const e = kids[i];
      if (!e) return;
      S.idToEl.set(String(b.id), e);
      S.byId.set(String(b.id), b);
      const pg = b.pg | 0;
      e.dataset.pg = pg;
      e.dataset.btype = b.type;
      if (pg !== prevPg) e.dataset.pgstart = pg + 1;
      prevPg = pg;
      if (b.mt != null) e.style.marginTop = `${b.mt}em`;
      if (b.mb != null) e.style.marginBottom = `${b.mb}em`;
      if (b.indent != null) e.style.paddingLeft = `${b.indent}em`;
      if (b.align) e.style.textAlign = b.align;
      if (b.type === "quote") e.classList.add("quote-block");
    });
    S.starts = Core.pageStarts(S.blocks, S.pageCount);
    applyGlobal();
    layoutAll();
  }

  engine.loadBook = function (payload) {
    clearTimeout(saveTimer);
    saveTimer = null;
    S.book = payload.book || {};
    S.rawBlocks = payload.blocks || [];
    S.userdata = sanitizeUserdata(payload.userdata);
    S.history.clear();
    if (S.editMode) leaveEdit();
    S.selEl = null;
    S.selId = null;
    closePanel();
    closeSearch();

    const maxPg = S.rawBlocks.reduce((m, b) => Math.max(m, b.pg | 0), 0);
    S.pageCount = Math.max(1, Number(S.book.page_count) || maxPg + 1);

    S.blocks = Core.applyEdits(S.rawBlocks, E());
    const book = Object.assign({}, S.book, {
      current_block: Core.nearestSurvivingId(S.blocks, Number(S.book.current_block) || 0),
    });
    origLoad(Object.assign({}, payload, { book, blocks: S.blocks }));
    postRender();
    refreshBookmarks();
  };

  function reRender() {
    const a = getAnchor();
    S.blocks = Core.applyEdits(S.rawBlocks, E());
    const wanted = Core.nearestSurvivingId(S.blocks, a.id);
    const book = Object.assign({}, S.book, {
      current_block: wanted,
      current_offset: wanted === a.id ? a.offset : 0,
    });
    origLoad({ book, blocks: S.blocks, fullscreen: flag("fullscreen"), maximized: flag("maximized") });
    postRender();
    requestAnimationFrame(() => {
      const e = S.idToEl.get(String(wanted));
      if (e && wanted === a.id) window.scrollBy(0, e.getBoundingClientRect().top - a.top);
      reselect();
      layoutAll();
      refreshBookmarks();
    });
  }

  // ------------------------------------------------------------------
  // Compact 200px Smooth Scrollbar (with damped lerp scrolling)
  // ------------------------------------------------------------------
  const sbEl = h(
    "div",
    "rd-scroll",
    '<div class="rd-track"></div><div class="rd-marks"></div><div class="rd-thumb"></div><div class="rd-tip"></div>'
  );
  const sbThumb = $(".rd-thumb", sbEl);
  const sbMarks = $(".rd-marks", sbEl);
  const sbTip = $(".rd-tip", sbEl);
  document.body.appendChild(sbEl);

  let sbIdle;
  let sbDragging = false;
  let sbHover = false;
  let targetScrollY = null;
  let smoothScrollRaf = 0;

  function wake(ms = 1500) {
    sbEl.classList.add("awake");
    clearTimeout(sbIdle);
    sbIdle = setTimeout(() => {
      if (!sbDragging && !sbHover) sbEl.classList.remove("awake");
    }, ms);
  }

  function scrollMetrics() {
    const doc = document.documentElement;
    const vh = window.innerHeight;
    const sh = doc.scrollHeight;
    const trackH = sbEl.clientHeight || 200;
    const thumbH = clamp(trackH * (vh / Math.max(sh, 1)), 24, trackH);
    return { vh, sh, trackH, thumbH, maxScroll: Math.max(sh - vh, 0) };
  }

  function updateThumb() {
    const m = scrollMetrics();
    sbEl.classList.toggle("rd-nope", m.maxScroll <= 0);
    const top = m.maxScroll > 0 ? (window.scrollY / m.maxScroll) * (m.trackH - m.thumbH) : 0;
    sbThumb.style.height = `${m.thumbH}px`;
    sbThumb.style.transform = `translateY(${top}px)`;
  }

  function pageAtAbsY(absY) {
    const blk = S.blocks[blockIndexAtY(absY)];
    return blk ? (blk.pg | 0) + 1 : 1;
  }

  function showTip(clientY) {
    const rect = sbEl.getBoundingClientRect();
    const m = scrollMetrics();
    const frac = clamp((clientY - rect.top - m.thumbH / 2) / Math.max(m.trackH - m.thumbH, 1), 0, 1);
    const page = pageAtAbsY(frac * m.maxScroll + 48);
    sbTip.textContent = `Page ${page}`;
    sbTip.style.transform = `translateY(${clamp(clientY - rect.top, 8, m.trackH - 8)}px)`;
    sbTip.classList.add("show");
  }

  function tickSmoothDrag() {
    if (targetScrollY === null) {
      smoothScrollRaf = 0;
      return;
    }
    const current = window.scrollY;
    const diff = targetScrollY - current;
    if (Math.abs(diff) < 1.5) {
      window.scrollTo({ top: targetScrollY, behavior: "instant" });
      if (!sbDragging) {
        targetScrollY = null;
        smoothScrollRaf = 0;
        return;
      }
    } else {
      const maxStep = Math.max(window.innerHeight * 1.25, 900);
      const step = clamp(diff * 0.16, -maxStep, maxStep);
      window.scrollTo({ top: current + step, behavior: "instant" });
    }
    smoothScrollRaf = requestAnimationFrame(tickSmoothDrag);
  }

  function scrollToTrackY(clientY, grab) {
    const rect = sbEl.getBoundingClientRect();
    const m = scrollMetrics();
    const frac = clamp((clientY - rect.top - grab) / Math.max(m.trackH - m.thumbH, 1), 0, 1);
    targetScrollY = frac * m.maxScroll;
    if (!smoothScrollRaf) {
      smoothScrollRaf = requestAnimationFrame(tickSmoothDrag);
    }
  }

  function layoutMarks() {
    sbMarks.innerHTML = "";
  }

  safe("scrollbar", () => {
    sbThumb.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      sbDragging = true;
      sbEl.classList.add("awake", "dragging");
      sbThumb.setPointerCapture(e.pointerId);
      const grab = e.clientY - sbThumb.getBoundingClientRect().top;
      const move = (ev) => {
        scrollToTrackY(ev.clientY, grab);
        showTip(ev.clientY);
      };
      const up = () => {
        sbDragging = false;
        sbEl.classList.remove("dragging");
        sbTip.classList.remove("show");
        sbThumb.removeEventListener("pointermove", move);
        sbThumb.removeEventListener("pointerup", up);
        sbThumb.removeEventListener("pointercancel", up);
        wake(900);
      };
      sbThumb.addEventListener("pointermove", move);
      sbThumb.addEventListener("pointerup", up);
      sbThumb.addEventListener("pointercancel", up);
      move(e);
    });

    sbEl.addEventListener("pointerdown", (e) => {
      if (e.target !== sbEl && !e.target.classList.contains("rd-track")) return;
      scrollToTrackY(e.clientY, scrollMetrics().thumbH / 2);
    });
    sbEl.addEventListener("pointerenter", () => {
      sbHover = true;
      wake(60000);
    });
    sbEl.addEventListener("pointerleave", () => {
      sbHover = false;
      sbTip.classList.remove("show");
      wake(900);
    });
    sbEl.addEventListener("pointermove", (e) => {
      if (!sbDragging) showTip(e.clientY);
    });

    document.addEventListener(
      "pointermove",
      (e) => {
        if (e.clientX > window.innerWidth - 64) wake(1600);
      },
      { passive: true }
    );
  });

  // ------------------------------------------------------------------
  // Page indicator + seek (bottom-left)
  // ------------------------------------------------------------------
  const pgEl = h(
    "div",
    "rd-page",
    '<button type="button" class="rd-page-btn" title="Go to page (G)"><span class="rd-cur">1</span><span class="rd-sep">/</span><span class="rd-tot">1</span></button>' +
      '<input class="rd-page-input" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="Page" aria-label="Go to page" />'
  );
  const pgBtn = $(".rd-page-btn", pgEl);
  const pgCur = $(".rd-cur", pgEl);
  const pgTot = $(".rd-tot", pgEl);
  const pgInput = $(".rd-page-input", pgEl);
  document.body.appendChild(pgEl);

  function updatePageIndicator() {
    if (!S.blocks.length) return;
    pgCur.textContent = String(pageAtAbsY(window.scrollY + 48));
    pgTot.textContent = String(S.pageCount);
  }

  function goToPage(n) {
    const page = clamp(Math.round(n), 1, S.pageCount);
    const idx = S.starts[page - 1];
    const e = streamEl.children[idx];
    if (!e) return;
    scrollToEl(e);
    flashBookmarkTarget(e, null);
    wake(1400);
  }

  function openPageInput() {
    S.pageInputOpen = true;
    pgEl.classList.add("editing");
    pgInput.value = "";
    pgInput.focus();
    syncModal();
  }

  function closePageInput() {
    if (!S.pageInputOpen) return;
    S.pageInputOpen = false;
    pgEl.classList.remove("editing");
    pgInput.blur();
    syncModal();
  }

  safe("pageIndicator", () => {
    pgBtn.addEventListener("click", openPageInput);
    pgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const raw = pgInput.value.trim();
        if (raw.endsWith("%")) {
          const pct = clamp(parseFloat(raw), 0, 100) / 100;
          window.scrollTo({ top: pct * scrollMetrics().maxScroll, behavior: "instant" });
        } else if (raw && !Number.isNaN(Number(raw))) {
          goToPage(Number(raw));
        }
        closePageInput();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePageInput();
      }
    });
    pgInput.addEventListener("blur", closePageInput);
  });

  // ------------------------------------------------------------------
  // Bookmarks + Floating Left-Margin Unbookmark Button on Hover
  // ------------------------------------------------------------------
  const pill = $("#top-left-hotspot .chrome-pill");
  const btnBm = h("button", "pill-btn", ICON.bookmark);
  btnBm.id = "btn-bookmarks";
  btnBm.title = "Bookmarks (Ctrl+D to add)";
  btnBm.setAttribute("aria-label", "Bookmarks");
  const btnEdit = h("button", "pill-btn", ICON.pencil);
  btnEdit.id = "btn-edit";
  btnEdit.title = "Edit book text (E)";
  btnEdit.setAttribute("aria-label", "Edit mode");
  if (pill) {
    pill.append(h("div", "pill-divider"), btnBm, h("div", "pill-divider"), btnEdit);
  }

  const panel = h(
    "div",
    "rd-panel",
    '<header class="rd-panel-head"><span class="rd-panel-title">Bookmarks <span class="rd-count"></span></span>' +
      '<button type="button" class="rd-add">Add here</button></header><div class="rd-list"></div>'
  );
  panel.setAttribute("aria-hidden", "true");
  document.body.appendChild(panel);
  const listEl = $(".rd-list", panel);
  const countEl = $(".rd-count", panel);

  // Single floating unbookmark button attached to body (never mutates book paragraphs)
  const hoverUnbmBtn = h("button", "rd-hover-unbm", ICON.bookmarkFilled);
  hoverUnbmBtn.type = "button";
  hoverUnbmBtn.title = "Click to unbookmark";
  document.body.appendChild(hoverUnbmBtn);
  let hoveredBmBlockKey = null;
  let hideHoverBtnTimer = null;

  function positionHoverUnbm(blockEl, blockKey) {
    clearTimeout(hideHoverBtnTimer);
    hoveredBmBlockKey = blockKey;
    const rect = blockEl.getBoundingClientRect();
    const left = Math.max(8, rect.left - 38);
    const top = rect.top + 2;
    hoverUnbmBtn.style.left = `${Math.round(left)}px`;
    hoverUnbmBtn.style.top = `${Math.round(top)}px`;
    hoverUnbmBtn.classList.add("show");
  }

  function scheduleHideHoverUnbm() {
    clearTimeout(hideHoverBtnTimer);
    hideHoverBtnTimer = setTimeout(() => {
      hoverUnbmBtn.classList.remove("show");
      hoveredBmBlockKey = null;
    }, 180);
  }

  hoverUnbmBtn.addEventListener("mouseenter", () => clearTimeout(hideHoverBtnTimer));
  hoverUnbmBtn.addEventListener("mouseleave", scheduleHideHoverUnbm);
  hoverUnbmBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hoveredBmBlockKey) return;
    const bms = S.bmByBlock.get(hoveredBmBlockKey) || [];
    if (!bms.length) return;
    const ids = new Set(bms.map((b) => b.id));
    S.userdata.bookmarks = S.userdata.bookmarks.filter((b) => !ids.has(b.id));
    hoverUnbmBtn.classList.remove("show");
    hoveredBmBlockKey = null;
    persistNow();
    refreshBookmarks();
    toast("Unbookmarked");
  });

  streamEl.addEventListener("mousemove", (e) => {
    const blockEl = e.target.closest && e.target.closest("[data-block-id]");
    if (!blockEl || !streamEl.contains(blockEl)) {
      scheduleHideHoverUnbm();
      return;
    }
    const key = String(blockEl.dataset.blockId);
    if (S.bmByBlock.has(key)) {
      positionHoverUnbm(blockEl, key);
    } else {
      scheduleHideHoverUnbm();
    }
  });
  streamEl.addEventListener("mouseleave", scheduleHideHoverUnbm);

  function syncBookmarkedBlocks() {
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete("rd-bm"); // Never keep permanent blue background
    }
    S.bmByBlock = new Map();
    for (const bm of S.userdata.bookmarks) {
      const survivingId = Core.nearestSurvivingId(S.blocks, bm.block_id);
      const key = String(survivingId);
      if (!S.bmByBlock.has(key)) S.bmByBlock.set(key, []);
      S.bmByBlock.get(key).push(bm);
    }
    if (hoveredBmBlockKey && !S.bmByBlock.has(hoveredBmBlockKey)) {
      hoverUnbmBtn.classList.remove("show");
      hoveredBmBlockKey = null;
    }
  }

  function openPanel() {
    const dd = $("#reader-dropdown");
    if (dd && dd.classList.contains("open")) $("#btn-dropdown").click();
    S.panelOpen = true;
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    renderBookmarkList();
    syncModal();
  }
  function closePanel() {
    if (!S.panelOpen) return;
    S.panelOpen = false;
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    syncModal();
  }

  function renderBookmarkList() {
    const items = Core.sortBookmarks(S.userdata.bookmarks);
    countEl.textContent = items.length ? `(${items.length})` : "";
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.appendChild(
        h("div", "rd-empty", "No bookmarks yet.<br>Select text and press <b>Bookmark</b>, or press <b>Add here</b>.")
      );
      return;
    }
    for (const bm of items) {
      const row = h("div", "rd-bm");
      const main = h("button", "rd-bm-main");
      main.type = "button";
      const quote = h("div", "rd-bm-quote");
      quote.textContent = bm.quote ? `\u201c${Core.collapse(bm.quote).slice(0, 120)}\u201d` : "Bookmark";
      const meta = h("div", "rd-bm-meta");
      meta.textContent = `Page ${(bm.pg | 0) + 1}${bm.kind === "pos" ? " \u00b7 place" : ""}${bm.note ? " \u00b7 " + bm.note : ""}`;
      main.append(quote, meta);
      main.addEventListener("click", () => jumpToBookmark(bm));

      const note = h("button", "rd-bm-btn", ICON.pencil);
      note.type = "button";
      note.title = "Add a note";
      note.addEventListener("click", () => {
        if (row.querySelector(".rd-note")) return;
        const input = h("input", "rd-note");
        input.placeholder = "Note\u2026";
        input.value = bm.note || "";
        row.appendChild(input);
        input.focus();
        const done = () => {
          bm.note = input.value.trim().slice(0, 140);
          persistNow();
          renderBookmarkList();
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") done();
          if (e.key === "Escape") {
            e.preventDefault();
            renderBookmarkList();
          }
        });
        input.addEventListener("blur", done);
      });

      const del = h("button", "rd-bm-btn", ICON.close);
      del.type = "button";
      del.title = "Remove bookmark";
      del.addEventListener("click", () => removeBookmark(bm.id));
      row.append(main, note, del);
      listEl.appendChild(row);
    }
  }

  function refreshBookmarks() {
    layoutMarks();
    syncBookmarkedBlocks();
    if (S.panelOpen) renderBookmarkList();
  }

  function addBookmark(bm) {
    S.userdata.bookmarks.push(bm);
    persistNow();
    refreshBookmarks();
  }

  function removeBookmark(id) {
    S.userdata.bookmarks = S.userdata.bookmarks.filter((b) => b.id !== id);
    persistNow();
    refreshBookmarks();
  }

  function jumpToBookmark(bm) {
    const id = Core.nearestSurvivingId(S.blocks, bm.block_id);
    const e = S.idToEl.get(String(id));
    if (!e) return;
    const r = e.getBoundingClientRect();
    const extra = bm.kind === "pos" ? r.height * (bm.offset || 0) : 0;
    scrollToEl(e, extra - 24);
    flashBookmarkTarget(e, bm.kind === "text" ? bm.quote : null);
    closePanel();
  }

  function toggleCurrentPlace() {
    const a = getAnchor();
    const blk = S.blocks[a.index];
    if (!blk) return;
    const existing = S.userdata.bookmarks.find((b) => b.kind === "pos" && b.block_id === blk.id);
    if (existing) {
      removeBookmark(existing.id);
      toast("Bookmark removed");
      return;
    }
    const snippet = blk.type === "img" ? "Illustration" : Core.collapse(blk.text).slice(0, 140);
    addBookmark({
      id: Core.uid(),
      kind: "pos",
      block_id: blk.id,
      offset: a.offset,
      pg: blk.pg | 0,
      quote: snippet,
      note: "",
      t: Date.now(),
    });
    toast(`Bookmarked page ${(blk.pg | 0) + 1}`);
  }

  function bookmarkSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const text = Core.collapse(sel.toString()).slice(0, 500);
    if (!text) return;
    let node = range.startContainer;
    node = node.nodeType === 1 ? node : node.parentElement;
    const blockEl = node && node.closest("[data-block-id]");
    if (!blockEl || !streamEl.contains(blockEl)) return;
    const blk = S.byId.get(String(blockEl.dataset.blockId));
    if (!blk) return;
    const pop = $("#selection-popover");
    const closePop = () => {
      if (!pop) return;
      pop.classList.remove("open");
      pop.style.opacity = "";
      pop.style.pointerEvents = "";
    };
    const existing = S.userdata.bookmarks.find((b) => b.block_id === blk.id && b.quote === text);
    if (existing) {
      removeBookmark(existing.id);
      sel.removeAllRanges();
      closePop();
      toast("Bookmark removed");
      return;
    }
    addBookmark({
      id: Core.uid(),
      kind: "text",
      block_id: blk.id,
      offset: 0,
      pg: blk.pg | 0,
      quote: text,
      note: "",
      t: Date.now(),
    });
    sel.removeAllRanges();
    closePop();
    toast("Bookmarked");
  }

  safe("selectionBookmarkBtn", () => {
    const toolbar = $("#selection-popover .sel-toolbar");
    if (!toolbar) return;
    const btn = h(
      "button",
      "sel-btn",
      ICON.bookmark.replace('width="16" height="16"', 'width="13.5" height="13.5"') + "<span>Bookmark</span>"
    );
    btn.type = "button";
    btn.id = "btn-sel-bookmark";
    btn.title = "Bookmark this selection";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      bookmarkSelection();
    });
    toolbar.insertBefore(btn, $("#btn-sel-copy", toolbar));
  });

  safe("bookmarkUI", () => {
    btnBm.addEventListener("click", (e) => {
      e.stopPropagation();
      S.panelOpen ? closePanel() : openPanel();
    });
    $(".rd-add", panel).addEventListener("click", toggleCurrentPlace);
    $("#btn-dropdown") && $("#btn-dropdown").addEventListener("click", closePanel, true);
    document.addEventListener("mousedown", (e) => {
      if (S.panelOpen && !panel.contains(e.target) && !btnBm.contains(e.target)) closePanel();
    });
  });

  // ------------------------------------------------------------------
  // Scroll + resize wiring
  // ------------------------------------------------------------------
  let scrollRaf = 0;
  window.addEventListener(
    "scroll",
    () => {
      hoverUnbmBtn.classList.remove("show");
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        updateThumb();
        updatePageIndicator();
        if (!sbDragging) wake(1300);
      });
    },
    { passive: true }
  );

  const layoutAll = debounce(() => {
    updateThumb();
    updatePageIndicator();
    layoutMarks();
    syncBookmarkedBlocks();
  }, 60);
  window.addEventListener("resize", layoutAll);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(layoutAll).observe(streamEl);

  // ------------------------------------------------------------------
  // Ctrl+F In-Book Search Bar
  // ------------------------------------------------------------------
  const searchBar = h(
    "div",
    "rd-search",
    `<span class="rd-search-icon">${ICON.search}</span>` +
      '<input type="text" class="rd-search-input" placeholder="Find in book…" autocomplete="off" spellcheck="false" />' +
      '<span class="rd-search-count"></span>' +
      `<button type="button" class="rd-search-btn" data-sact="prev" title="Previous match (Shift+Enter)">${ICON.chevUp}</button>` +
      `<button type="button" class="rd-search-btn" data-sact="next" title="Next match (Enter)">${ICON.chevDown}</button>` +
      `<button type="button" class="rd-search-btn" data-sact="close" title="Close search (Esc)">${ICON.close}</button>`
  );
  document.body.appendChild(searchBar);
  const searchInput = $(".rd-search-input", searchBar);
  const searchCountEl = $(".rd-search-count", searchBar);

  let searchMatches = [];
  let searchActiveIdx = -1;

  function clearSearchHighlights() {
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete("rd-search");
      CSS.highlights.delete("rd-search-active");
    }
  }

  function runSearch(query) {
    searchMatches = [];
    searchActiveIdx = -1;
    clearSearchHighlights();
    const q = (query || "").trim().toLowerCase();
    if (!q) {
      searchCountEl.textContent = "";
      return;
    }

    for (const blk of S.blocks) {
      if (blk.type === "img" || !blk.text) continue;
      const el = S.idToEl.get(String(blk.id));
      if (!el) continue;
      const root = textRoot(el);
      const hay = (root.textContent || "").toLowerCase();
      let pos = 0;
      while ((pos = hay.indexOf(q, pos)) !== -1) {
        searchMatches.push({ blockId: blk.id, start: pos, end: pos + q.length });
        pos += q.length;
        if (searchMatches.length >= 500) break;
      }
      if (searchMatches.length >= 500) break;
    }

    if (!searchMatches.length) {
      searchCountEl.textContent = "0/0";
      return;
    }

    const anchor = getAnchor();
    let bestIdx = searchMatches.findIndex((m) => m.blockId >= anchor.id);
    if (bestIdx < 0) bestIdx = 0;
    focusSearchMatch(bestIdx);
  }

  function paintSearchHighlights() {
    if (!window.CSS || !CSS.highlights || typeof Highlight === "undefined") return;
    clearSearchHighlights();
    if (!searchMatches.length) return;
    const allRanges = [];
    let activeRange = null;

    searchMatches.forEach((m, idx) => {
      const el = S.idToEl.get(String(m.blockId));
      if (!el) return;
      const r = rangeFromOffsets(textRoot(el), m.start, m.end);
      if (!r) return;
      if (idx === searchActiveIdx) activeRange = r;
      else allRanges.push(r);
    });

    if (allRanges.length) CSS.highlights.set("rd-search", new Highlight(...allRanges));
    if (activeRange) CSS.highlights.set("rd-search-active", new Highlight(activeRange));
  }

  function focusSearchMatch(idx) {
    if (!searchMatches.length) return;
    searchActiveIdx = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
    searchCountEl.textContent = `${searchActiveIdx + 1}/${searchMatches.length}`;
    const match = searchMatches[searchActiveIdx];
    const el = S.idToEl.get(String(match.blockId));
    if (el) {
      const r = rangeFromOffsets(textRoot(el), match.start, match.end);
      const rect = r ? r.getBoundingClientRect() : el.getBoundingClientRect();
      const targetY = window.scrollY + rect.top - window.innerHeight * 0.35;
      window.scrollTo({ top: Math.max(0, targetY), behavior: "instant" });
    }
    paintSearchHighlights();
  }

  function openSearch() {
    S.searchOpen = true;
    searchBar.classList.add("open");
    const sel = window.getSelection();
    const selectedText = sel && !sel.isCollapsed ? sel.toString().trim() : "";
    if (selectedText && selectedText.length <= 80) {
      searchInput.value = selectedText;
      runSearch(selectedText);
    }
    searchInput.focus();
    searchInput.select();
    syncModal();
  }

  function closeSearch() {
    if (!S.searchOpen) return;
    S.searchOpen = false;
    searchBar.classList.remove("open");
    clearSearchHighlights();
    searchInput.blur();
    syncModal();
  }

  safe("searchBar", () => {
    searchInput.addEventListener(
      "input",
      debounce(() => runSearch(searchInput.value), 120)
    );
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (searchMatches.length) focusSearchMatch(searchActiveIdx + (e.shiftKey ? -1 : 1));
        else runSearch(searchInput.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSearch();
      }
    });
    searchBar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sact]");
      if (!btn) return;
      const act = btn.dataset.sact;
      if (act === "prev") focusSearchMatch(searchActiveIdx - 1);
      else if (act === "next") focusSearchMatch(searchActiveIdx + 1);
      else if (act === "close") closeSearch();
    });
  });

  // ------------------------------------------------------------------
  // Edit mode (Clean controls, Merge Up + Merge Down matching first block's style)
  // ------------------------------------------------------------------
const dock = h("div", "rd-dock");
  dock.innerHTML =
    '<div class="rd-dock-block">' +
    '<div class="rd-group"><span class="rd-glabel">Style</span><div class="rd-seg" data-role="types">' +
    '<button type="button" data-type="p">Paragraph</button><button type="button" data-type="h1">H1</button><button type="button" data-type="h2">H2</button>' +
    '<button type="button" data-type="lines">Verse</button><button type="button" data-type="li">List</button><button type="button" data-type="quote">Quote</button></div></div>' +
    '<div class="rd-group"><span class="rd-glabel">Top space</span><div class="rd-step" data-prop="mt"><button type="button" data-d="-1">&minus;</button><span class="rd-val">0</span><button type="button" data-d="1">+</button></div></div>' +
    '<div class="rd-group"><span class="rd-glabel">Bottom space</span><div class="rd-step" data-prop="mb"><button type="button" data-d="-1">&minus;</button><span class="rd-val">0</span><button type="button" data-d="1">+</button></div></div>' +
    '<div class="rd-group"><span class="rd-glabel">Indent</span><div class="rd-step" data-prop="indent"><button type="button" data-d="-1">&minus;</button><span class="rd-val">0</span><button type="button" data-d="1">+</button></div></div>' +
    '<div class="rd-group rd-actions">' +
    '<button type="button" data-act="add-above" title="Create a new block above this one">+ Above</button>' +
    '<button type="button" data-act="add-below" title="Create a new block below this one">+ Below</button>' +
    '<button type="button" data-act="merge-up" title="Merge this block into the block above (keeps upper block style)">Merge with above</button>' +
    '<button type="button" data-act="merge-down" title="Merge the block below into this block (keeps this block style)">Merge with below</button>' +
    '<button type="button" data-act="split" title="Split into two paragraphs at cursor (Ctrl+Shift+Enter)">Split at cursor</button>' +
    '<button type="button" data-act="reset" title="Restore original block">Reset block</button>' +
    '<button type="button" data-act="del" class="rd-danger" title="Delete this block">Delete</button>' +
    "</div>" +
    "</div>" +
    '<div class="rd-dock-main">' +
    '<span class="rd-hint">Click any paragraph or heading to edit, split, or merge it</span>' +
    '<div class="rd-group"><span class="rd-glabel">Paragraph spacing</span><div class="rd-step" data-gprop="pspace"><button type="button" data-d="-1">&minus;</button><span class="rd-val">1.25</span><button type="button" data-d="1">+</button></div></div>' +
    '<div class="rd-group"><span class="rd-glabel">First-line indent</span><div class="rd-step" data-gprop="pindent"><button type="button" data-d="-1">&minus;</button><span class="rd-val">0</span><button type="button" data-d="1">+</button></div></div>' +
    '<div class="rd-group rd-actions"><button type="button" data-act="undo" title="Undo (Ctrl+Z)">Undo</button><button type="button" data-act="redo" title="Redo (Ctrl+Shift+Z)">Redo</button>' +
    '<button type="button" data-act="resetall" class="rd-danger">Reset all edits</button><button type="button" data-act="done" class="rd-primary">Done</button></div>' +
    "</div>";
  document.body.appendChild(dock);
  const dockBlock = $(".rd-dock-block", dock);

  const selBlock = () => (S.selId == null ? null : S.byId.get(String(S.selId)) || null);
  const textTarget = (el) => {
    if (!el || el.dataset.btype === "img" || el.dataset.btype === "toc") return null;
    return el.classList.contains("li") ? el.querySelector(".li-text") : el;
  };

  function ensureEntry(id) {
    const key = String(id);
    if (!E().blocks[key]) {
      const raw = S.rawBlocks[id];
      E().blocks[key] = { sig: Core.sig(raw ? raw.text : "") };
    }
    return E().blocks[key];
  }
  function segOf(b) {
    const parent = b._parent != null ? b._parent : Math.floor(b.id);
    const listName = b._pos === "before" ? "before" : "after";
    const ent = ensureEntry(parent);
    const arr = ent[listName];
    const k = b._k != null ? b._k : Math.round((b.id - parent) * 1000) - 1;
    return arr && arr[k] ? { ent, arr, listName, seg: arr[k], k, parent } : null;
  }
  function patchBlock(b, patch) {
    if (b._inserted) {
      const r = segOf(b);
      if (r) Object.assign(r.seg, patch);
    } else Object.assign(ensureEntry(b.id), patch);
  }
  function deleteBlock(b) {
    if (b._inserted) {
      const r = segOf(b);
      if (r) {
        r.arr.splice(r.k, 1);
        if (!r.arr.length) delete r.ent[r.listName];
      }
    } else ensureEntry(b.id).del = true;
  }

  function mutate(fn) {
    S.history.record(JSON.stringify(E()));
    S.typing = false;
    fn();
    persistNow();
    reRender();
  }

  function mergeTwoBlocks(first, second) {
    const ok = (x) => x && x.type !== "img" && x.type !== "toc";
    if (!ok(first) || !ok(second)) {
      toast("Cannot merge this block type");
      return;
    }
    const firstStyle = first.type;
    const caretPos = (first.text || "").length;
    S.afterRender = { id: first.id, caretOffset: caretPos };
    S.selId = first.id;
    mutate(() => {
      patchBlock(first, {
        type: firstStyle,
        text: Core.joinText(first.text, second.text, firstStyle),
      });
      deleteBlock(second);
    });
  }

  function mergeUp(b) {
    const i = S.blocks.indexOf(b);
    mergeTwoBlocks(S.blocks[i - 1], b);
  }

  function mergeDown(b) {
    const i = S.blocks.indexOf(b);
    mergeTwoBlocks(b, S.blocks[i + 1]);
  }

  function insertAdjacentBlock(b, dir) {
    let newId;
    const defaultText = "New paragraph";
    mutate(() => {
      if (b._inserted) {
        const r = segOf(b);
        if (!r) return;
        const insertIdx = dir === "above" ? r.k : r.k + 1;
        r.arr.splice(insertIdx, 0, { text: defaultText, type: "p" });
        const newLen = r.arr.length;
        if (r.listName === "before") {
          newId = Number((r.parent - (newLen - insertIdx) / 1000).toFixed(3));
        } else {
          newId = Number((r.parent + (insertIdx + 1) / 1000).toFixed(3));
        }
      } else {
        const ent = ensureEntry(b.id);
        if (dir === "above") {
          ent.before = (ent.before || []).concat([{ text: defaultText, type: "p" }]);
          newId = Number((b.id - 1 / 1000).toFixed(3));
        } else {
          ent.after = [{ text: defaultText, type: "p" }].concat(ent.after || []);
          newId = Number((b.id + 1 / 1000).toFixed(3));
        }
      }
    });
    if (newId != null) {
      S.afterRender = { id: newId, caret: "end", selectAll: true };
      S.selId = newId;
    }
  }

  function splitBlock(b, offset, forceParagraphs = false) {
    const text = b.text || "";
    const left = text.slice(0, offset).replace(/\s+$/, "");
    const right = text.slice(offset).replace(/^\s+/, "");
    if (!left || !right) {
      toast("Place the cursor inside the text to split");
      return;
    }
    let newId;
    mutate(() => {
      if (b._inserted) {
        const r = segOf(b);
        if (!r) return;
        const targetType = forceParagraphs ? "p" : r.seg.type;
        r.seg.text = left;
        r.seg.type = targetType;
        r.arr.splice(r.k + 1, 0, { text: right, type: targetType });
        const newLen = r.arr.length;
        if (r.listName === "before") {
          newId = Number((r.parent - (newLen - (r.k + 1)) / 1000).toFixed(3));
        } else {
          newId = Number((r.parent + (r.k + 2) / 1000).toFixed(3));
        }
      } else {
        const ent = ensureEntry(b.id);
        const targetType = forceParagraphs ? "p" : b.type;
        ent.text = left;
        if (forceParagraphs) ent.type = "p";
        ent.after = [{ text: right, type: targetType }].concat(ent.after || []);
        newId = Number((b.id + 1 / 1000).toFixed(3));
      }
    });
    S.afterRender = { id: newId, caret: "start" };
    S.selId = newId;
  }

  function computedEm(el, prop) {
    const cs = getComputedStyle(el);
    const px = parseFloat(prop === "indent" ? cs.paddingLeft : cs[prop === "mt" ? "marginTop" : "marginBottom"]) || 0;
    return px / (parseFloat(cs.fontSize) || 16);
  }

  function adjustBlock(prop, dir) {
    const b = selBlock();
    if (!b || !S.selEl) return;
    const cur = b[prop] != null ? b[prop] : computedEm(S.selEl, prop);
    const step = prop === "indent" ? 1 : 0.25;
    const max = prop === "indent" ? 8 : 6;
    const next = clamp(Math.round((cur + dir * step) / step) * step, 0, max);
    mutate(() => patchBlock(b, { [prop]: next }));
  }

  function adjustGlobal(prop, dir) {
    const defaults = { pspace: [1.25, 0.25, 0, 4], pindent: [0, 0.5, 0, 4] }[prop];
    const cur = E().global[prop] != null ? E().global[prop] : defaults[0];
    S.history.record(JSON.stringify(E()));
    E().global[prop] = clamp(
      Math.round((cur + dir * defaults[1]) / defaults[1]) * defaults[1],
      defaults[2],
      defaults[3]
    );
    persistNow();
    applyGlobal();
    layoutAll();
    updateDock();
  }

  function undoRedo(kind) {
    const snap = JSON.stringify(E());
    const target = kind === "undo" ? S.history.undo(snap) : S.history.redo(snap);
    if (target == null) {
      toast(kind === "undo" ? "Nothing to undo" : "Nothing to redo");
      return;
    }
    S.userdata.edits = JSON.parse(target);
    S.typing = false;
    persistNow();
    reRender();
  }

  let resetArmed = null;
  function dockAction(act) {
    const b = selBlock();
    switch (act) {
      case "add-above":
        if (b) insertAdjacentBlock(b, "above");
        break;
      case "add-below":
        if (b) insertAdjacentBlock(b, "below");
        break;
      case "merge-up":
        if (b) mergeUp(b);
        break;
      case "merge-down":
        if (b) mergeDown(b);
        break;
      case "split": {
        if (!b) break;
        const off = caretOffset(textTarget(S.selEl));
        if (off < 0) toast("Click inside the text where you want to split");
        else splitBlock(b, off, true);
        break;
      }
      case "del":
        if (b) {
          S.selId = null;
          mutate(() => deleteBlock(b));
        }
        break;
      case "reset":
        if (b && !b._inserted) mutate(() => { delete E().blocks[String(b.id)]; });
        break;
      case "undo":
        undoRedo("undo");
        break;
      case "redo":
        undoRedo("redo");
        break;
      case "done":
        leaveEdit();
        break;
      case "resetall": {
        const btn = $('[data-act="resetall"]', dock);
        if (!resetArmed) {
          btn.textContent = "Click again to confirm";
          resetArmed = setTimeout(() => {
            resetArmed = null;
            btn.textContent = "Reset all edits";
          }, 3000);
        } else {
          clearTimeout(resetArmed);
          resetArmed = null;
          btn.textContent = "Reset all edits";
          S.selId = null;
          mutate(() => {
            S.userdata.edits = Core.emptyEdits();
          });
          applyGlobal();
        }
        break;
      }
      default:
        break;
    }
  }

  function updateDock() {
    const b = selBlock();
    dockBlock.classList.toggle("show", !!b);
    $(".rd-hint", dock).style.display = b ? "none" : ""; $$(".rd-seg button", dock).forEach((btn) => btn.classList.toggle("active", !!b && btn.dataset.type === b.type));
    if (b && S.selEl) {
      for (const prop of ["mt", "mb", "indent"]) {
        const v = b[prop] != null ? b[prop] : computedEm(S.selEl, prop);
        const span = $(`[data-prop="${prop}"] .rd-val`, dock);
        if (span) span.textContent = fmt(v);
      }
      const noText = b.type === "img" || b.type === "toc";
      $$('[data-act="split"], [data-act="merge-up"], [data-act="merge-down"]', dock).forEach(
        (x) => (x.disabled = noText)
      );
      $('[data-act="reset"]', dock).disabled = !!b._inserted;
    }
    const g = E().global || {};
    $('[data-gprop="pspace"] .rd-val', dock).textContent = fmt(g.pspace != null ? g.pspace : 1.25);
    $('[data-gprop="pindent"] .rd-val', dock).textContent = fmt(g.pindent != null ? g.pindent : 0);
    $('[data-act="undo"]', dock).disabled = !S.history.canUndo();
    $('[data-act="redo"]', dock).disabled = !S.history.canRedo();
  }

  function clearSelectionUI() {
    if (S.selEl) {
      S.selEl.classList.remove("rd-sel");
      const t = textTarget(S.selEl);
      if (t) t.removeAttribute("contenteditable");
    }
    S.selEl = null;
  }

  function selectBlock(el) {
    clearSelectionUI();
    S.selEl = el;
    S.selId = Number(el.dataset.blockId);
    S.typing = false;
    el.classList.add("rd-sel");
    const t = textTarget(el);
    if (t) t.setAttribute("contenteditable", "plaintext-only");
    updateDock();
  }

  function caretOffset(target) {
    if (!target) return -1;
    const s = window.getSelection();
    if (!s || !s.rangeCount) return -1;
    const r = s.getRangeAt(0);
    if (!r.collapsed || !target.contains(r.endContainer)) return -1;
    const pre = document.createRange();
    pre.selectNodeContents(target);
    pre.setEnd(r.endContainer, r.endOffset);
    return pre.toString().length;
  }

  function setCaret(target, offset, atEnd) {
    if (!target) return;
    target.focus({ preventScroll: true });
    const s = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    if (offset == null) {
      range.collapse(!atEnd);
    } else {
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      let pos = 0;
      let n;
      let placed = false;
      while ((n = walker.nextNode())) {
        if (offset <= pos + n.nodeValue.length) {
          range.setStart(n, offset - pos);
          range.collapse(true);
          placed = true;
          break;
        }
        pos += n.nodeValue.length;
      }
      if (!placed) range.collapse(false);
    }
    s.removeAllRanges();
    s.addRange(range);
  }

  function reselect() {
    if (!S.editMode || S.selId == null) {
      updateDock();
      return;
    }
    const el = S.idToEl.get(String(S.selId));
    S.selEl = null;
    if (!el) {
      S.selId = null;
      updateDock();
      return;
    }
    selectBlock(el);
    const ar = S.afterRender;
    S.afterRender = null;
    if (ar) {
      const t = textTarget(el);
      if (ar.selectAll && t) {
        t.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(t);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(range);
      } else if (ar.caretOffset != null) {
        setCaret(t, ar.caretOffset);
      } else {
        setCaret(t, null, ar.caret === "end");
      }
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function enterEdit() {
    if (S.editMode || !S.blocks.length) return;
    S.wasFast = flag("fast");
    if (S.wasFast) engine.applySettings({ fast_reading: false });
    S.editMode = true;
    document.body.classList.add("rd-editing");
    btnEdit.classList.add("active");
    dock.classList.add("show");
    closePanel();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    syncModal();
    updateDock();
  }

  function leaveEdit() {
    if (!S.editMode) return;
    clearSelectionUI();
    S.selId = null;
    persistNow();
    S.editMode = false;
    document.body.classList.remove("rd-editing");
    btnEdit.classList.remove("active");
    dock.classList.remove("show");
    if (S.wasFast) engine.applySettings({ fast_reading: true });
    S.wasFast = false;
    syncModal();
  }

  safe("editMode", () => {
    btnEdit.addEventListener("click", (e) => {
      e.stopPropagation();
      S.editMode ? leaveEdit() : enterEdit();
    });

    dock.addEventListener("mousedown", (e) => {
      if (!e.target.closest("input")) e.preventDefault();
    });
    dock.addEventListener("click", (e) => {
      const typeBtn = e.target.closest("[data-type]");
      if (typeBtn) {
        const b = selBlock();
        if (b && b.type !== typeBtn.dataset.type) mutate(() => patchBlock(b, { type: typeBtn.dataset.type }));
        return;
      }
      const step = e.target.closest(".rd-step button");
      if (step) {
        const wrap = step.closest(".rd-step");
        const dir = Number(step.dataset.d);
        if (wrap.dataset.gprop) adjustGlobal(wrap.dataset.gprop, dir);
        else adjustBlock(wrap.dataset.prop, dir);
        return;
      }
      const act = e.target.closest("[data-act]");
      if (act && !act.disabled) dockAction(act.dataset.act);
    });

    streamEl.addEventListener("click", (e) => {
      if (!S.editMode) return;
      const el = e.target.closest("[data-block-id]");
      if (!el || !streamEl.contains(el) || el === S.selEl) return;
      selectBlock(el);
      const t = textTarget(el);
      if (t) {
        t.focus({ preventScroll: true });
        const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
        if (r) {
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
      }
    });

    streamEl.addEventListener("input", () => {
      if (!S.editMode) return;
      const b = selBlock();
      const t = textTarget(S.selEl);
      if (!b || !t) return;
      if (!S.typing) {
        S.history.record(JSON.stringify(E()));
        S.typing = true;
      }
      let text = t.textContent;
      if (b.type !== "lines") text = text.replace(/\s*\n\s*/g, " ");
      b.text = text;
      txtRawUpdate(t, text);
      patchBlock(b, { text });
      persistSoon();
    });
  });

  function txtRawUpdate(target, text) {
    if (target && target.dataset) target.dataset.rawText = text;
  }

  function editorKey(e) {
    const b = selBlock();
    if (!b) return;
    // Ctrl+Shift+Enter: always split at cursor and convert both parts into paragraphs
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const off = caretOffset(e.target);
      if (off >= 0) splitBlock(b, off, true);
      return;
    }
    if (e.key === "Enter" && b.type !== "lines") {
      e.preventDefault();
      if (!e.shiftKey) {
        const off = caretOffset(e.target);
        if (off >= 0) splitBlock(b, off, false);
      }
    } else if (e.key === "Backspace" && caretOffset(e.target) === 0) {
      e.preventDefault();
      mergeUp(b);
    } else if (e.key === "Delete" && caretOffset(e.target) === (b.text || "").length) {
      e.preventDefault();
      mergeDown(b);
    }
  }

  // ------------------------------------------------------------------
  // Keyboard Shortcuts (including Ctrl+F Search)
  // ------------------------------------------------------------------
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
        return;
      }

      const t = e.target;
      const editable = t && t.isContentEditable;
      const typing = editable || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

      if (S.editMode && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        undoRedo(e.shiftKey ? "redo" : "undo");
        return;
      }
      if (S.editMode && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        undoRedo("redo");
        return;
      }
      if (S.editMode && editable) editorKey(e);
      if (editable || (S.editMode && !typing && (e.key === "b" || e.key === "B" || e.key === "m" || e.key === "M"))) {
        e.stopPropagation();
        return;
      }
      if (typing || e.altKey) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        toggleCurrentPlace();
      } else if (!e.ctrlKey && !e.metaKey) {
        if (e.key === "g" || e.key === "G") {
          e.preventDefault();
          openPageInput();
        } else if (e.key === "e" || e.key === "E") {
          S.editMode ? leaveEdit() : enterEdit();
        }
      }
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest && e.target.closest("#btn-back, #btn-close-app")) persistNow();
    },
    true
  );

  window.ReaditExtras = {
    escape() {
      if (S.searchOpen) return closeSearch();
      if (S.pageInputOpen) return closePageInput();
      if (S.selEl) {
        const t = textTarget(S.selEl);
        if (t) t.blur();
        clearSelectionUI();
        S.selId = null;
        return updateDock();
      }
      if (S.editMode) return leaveEdit();
      if (S.panelOpen) return closePanel();
      syncModal();
    },
  };

  applyGlobal();
  wake(2200);
})();