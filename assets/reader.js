(() => {
  "use strict";

  // ------------------------------------------------------------------
  // Element references
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  const streamEl = $("book-stream");
  const hotspotEl = $("top-left-hotspot");
  const dropdownEl = $("reader-dropdown");
  const btnBack = $("btn-back");
  const btnDropdown = $("btn-dropdown");
  const btnFullscreen = $("btn-fullscreen");
  const btnCloseApp = $("btn-close-app");

  const titleEl = $("dropdown-book-title");
  const progressEl = $("dropdown-progress");
  const valFontSize = $("val-font-size");
  const valWidth = $("val-width");
  const sliderWarmth = $("slider-warmth");
  const valWarmth = $("val-warmth");
  const sliderSaturation = $("slider-saturation");
  const valSaturation = $("val-saturation");
  const toggleColorful = $("toggle-colorful");
  const toggleFast = $("toggle-fast");
  const kelvinMatrix = $("kelvin-matrix");

  const fontPick = $("fontpick");
  const fontBtn = $("fontpick-btn");
  const fontCurrent = $("fontpick-current");
  const fontOpts = Array.from(document.querySelectorAll("#fontpick-list .fp-opt"));
  const strengthBtns = Array.from(document.querySelectorAll("#fast-strength button"));

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const READ_LINE = 48; // px from the top that counts as "where I'm reading"

  let totalBlocks = 0;
  let currentBlockId = 0;
  let currentOffset = 0.0;
  let currentProgressPct = 0.0;
  let isRestoringScroll = false;
  let saveTimer = null;
  let progressRaf = 0;

  let settings = {
    theme: "gnome-dark",
    font_family: "literata",
    font_size: 19,
    line_height: 1.75,
    max_width: 64,
    warmth: 0,
    saturation: 100,
    colorful_images: false,
    fast_reading: false,
    fast_strength: 2,
  };

  function postToHost(payload) {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.readit;
    if (h) h.postMessage(JSON.stringify(payload));
  }

  function progressPayload() {
    return {
      block_id: currentBlockId,
      offset: currentOffset,
      progress_pct: currentProgressPct,
    };
  }

  // ------------------------------------------------------------------
  // Fast reading: bright word starts, dimmer endings
  //   Colour only (no weight change) so toggling never reflows the text.
  //   Blocks are converted lazily as they approach the viewport.
  // ------------------------------------------------------------------
  const FAST_RATIOS = { 1: 0.35, 2: 0.5, 3: 0.65 };
  const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'\u2019]*/gu;

  function escapeHTML(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fixationLength(len, ratio) {
    if (len <= 2) return 1;
    return Math.max(1, Math.min(len - 1, Math.round(len * ratio)));
  }

  function fastHTML(text, ratio) {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(WORD_RE)) {
      const word = m[0];
      const idx = m.index;
      if (idx > last) out += escapeHTML(text.slice(last, idx));
      const k = fixationLength(word.length, ratio);
      out += `<span class="bf">${escapeHTML(word.slice(0, k))}</span>${escapeHTML(word.slice(k))}`;
      last = idx + word.length;
    }
    if (last < text.length) out += escapeHTML(text.slice(last));
    return out;
  }

  let fastObserver = null;
  const fastNear = new Set();

  function fastTarget(el) {
    return el.classList.contains("li") ? el.querySelector(".li-text") : el;
  }

  function applyFast(el) {
    const key = String(settings.fast_strength);
    if (el._fastKey === key) return;
    const target = fastTarget(el);
    if (!target) return;
    const raw = target.textContent; // equals the original text even if already converted
    target.innerHTML = fastHTML(raw, FAST_RATIOS[settings.fast_strength] || 0.5);
    target.classList.add("bionic-done");
    el._fastKey = key;
  }

  function clearFast(el) {
    if (el._fastKey == null) return;
    const target = fastTarget(el);
    if (target) {
      target.textContent = target.textContent;
      target.classList.remove("bionic-done");
    }
    el._fastKey = null;
  }

  function setupFastObserver() {
    if (fastObserver) fastObserver.disconnect();
    fastNear.clear();
    fastObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            fastNear.add(entry.target);
            if (settings.fast_reading) applyFast(entry.target);
          } else {
            fastNear.delete(entry.target);
          }
        }
      },
      { rootMargin: "1800px 0px 1800px 0px" }
    );
    streamEl.querySelectorAll("[data-fastable='1']").forEach((el) => fastObserver.observe(el));
  }

  function refreshFast() {
    if (settings.fast_reading) {
      fastNear.forEach(applyFast);
    } else {
      streamEl.querySelectorAll("[data-fastable='1']").forEach(clearFast);
    }
  }

  // ------------------------------------------------------------------
  // Night light (SVG colour matrix)
  // ------------------------------------------------------------------
  function updateKelvinWarmth(warmthVal) {
    const w = Math.max(0, Math.min(100, Number(warmthVal))) / 100;
    const g = (1.0 - w * 0.14).toFixed(3);
    const b = (1.0 - w * 0.36).toFixed(3);
    kelvinMatrix.setAttribute("values", `1 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`);
  }

  function setSliderFill(slider) {
    const min = Number(slider.min);
    const max = Number(slider.max);
    const pct = ((Number(slider.value) - min) / (max - min)) * 100;
    slider.style.setProperty("--fill", `${pct}%`);
  }

  // ------------------------------------------------------------------
  // Settings -> DOM
  // ------------------------------------------------------------------
  function applySettings(newSettings, persist = false) {
    const prevFast = settings.fast_reading;
    const prevStrength = settings.fast_strength;

    settings = { ...settings, ...newSettings };
    settings.fast_reading = Boolean(settings.fast_reading);
    settings.fast_strength = [1, 2, 3].includes(Number(settings.fast_strength))
      ? Number(settings.fast_strength)
      : 2;

    const body = document.body;
    body.setAttribute("data-theme", settings.theme);
    body.setAttribute("data-font", settings.font_family);
    body.setAttribute("data-colorful", settings.colorful_images ? "true" : "false");
    body.setAttribute("data-fast", settings.fast_reading ? "true" : "false");

    const root = document.documentElement.style;
    root.setProperty("--reader-font-size", `${settings.font_size}px`);
    root.setProperty("--reader-max-width", `${settings.max_width}ch`);
    root.setProperty("--reader-saturation", `${settings.saturation}%`);

    updateKelvinWarmth(settings.warmth);

    // Keep the panel controls in sync
    document.querySelectorAll(".theme-swatch").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-theme-val") === settings.theme);
    });

    fontOpts.forEach((opt) => {
      const selected = opt.dataset.font === settings.font_family;
      opt.classList.toggle("selected", selected);
      opt.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) fontCurrent.textContent = opt.dataset.label;
    });

    valFontSize.textContent = `${settings.font_size}px`;
    valWidth.textContent = `${settings.max_width}ch`;

    sliderWarmth.value = settings.warmth;
    valWarmth.textContent = `${settings.warmth}%`;
    setSliderFill(sliderWarmth);

    sliderSaturation.value = settings.saturation;
    valSaturation.textContent = `${settings.saturation}%`;
    setSliderFill(sliderSaturation);

    toggleColorful.checked = Boolean(settings.colorful_images);
    toggleFast.checked = settings.fast_reading;
    strengthBtns.forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.strength) === settings.fast_strength);
    });

    if (prevFast !== settings.fast_reading || prevStrength !== settings.fast_strength) {
      refreshFast();
    }

    if (persist) postToHost({ action: "save_settings", settings });
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function renderBlocks(blocks) {
    streamEl.innerHTML = "";
    const frag = document.createDocumentFragment();

    for (const blk of blocks) {
      let el;

      switch (blk.type) {
        case "img": {
          el = document.createElement("figure");
          el.className = "book-illustration-wrap";
          const img = document.createElement("img");
          img.className = "book-illustration";
          img.src = blk.src;
          if (blk.width && blk.height) {
            img.width = blk.width;
            img.height = blk.height;
          }
          img.loading = "lazy";
          el.appendChild(img);
          break;
        }

        case "toc": {
          el = document.createElement("div");
          const level = Number(blk.level) === 1 ? 1 : 2;
          el.className = `toc toc-l${level}${blk.page ? "" : " toc-nopage"}`;
          const title = document.createElement("span");
          title.className = "toc-title";
          title.textContent = blk.text;
          el.appendChild(title);
          if (blk.page) {
            const fill = document.createElement("span");
            fill.className = "toc-fill";
            const page = document.createElement("span");
            page.className = "toc-page";
            page.textContent = blk.page;
            el.append(fill, page);
          }
          break;
        }

        case "li": {
          el = document.createElement("div");
          el.className = "li";
          const mark = document.createElement("span");
          mark.className = "li-mark";
          mark.textContent = blk.marker || "";
          const text = document.createElement("span");
          text.className = "li-text";
          text.textContent = blk.text;
          el.append(mark, text);
          el.dataset.fastable = "1";
          break;
        }

        case "lines": {
          el = document.createElement("p");
          el.className = "lines";
          el.textContent = blk.text; // "\n" is preserved by CSS (white-space: pre-line)
          el.dataset.fastable = "1";
          break;
        }

        case "h1":
        case "h2": {
          el = document.createElement(blk.type);
          el.textContent = blk.text;
          break;
        }

        default: {
          el = document.createElement("p");
          el.textContent = blk.text;
          el.dataset.fastable = "1";
        }
      }

      el.dataset.blockId = blk.id;
      frag.appendChild(el);
    }

    streamEl.appendChild(frag);
  }

  // ------------------------------------------------------------------
  // Reading position
  // ------------------------------------------------------------------
  function restoreReadingPosition(blockId, offset) {
    isRestoringScroll = true;
    requestAnimationFrame(() => {
      const target = streamEl.querySelector(`[data-block-id="${blockId}"]`);
      if (target) {
        const rect = target.getBoundingClientRect();
        const exactY = window.scrollY + rect.top + rect.height * (Number(offset) || 0) - 36;
        window.scrollTo({ top: Math.max(0, exactY), behavior: "instant" });
      } else {
        window.scrollTo({ top: 0, behavior: "instant" });
      }
      setTimeout(() => {
        isRestoringScroll = false;
        computeAndRecordProgress();
      }, 120);
    });
  }

  // Run a layout-changing action while keeping the same sentence under your eyes
  function withAnchor(fn) {
    const blockId = currentBlockId;
    const offset = currentOffset;
    fn();
    restoreReadingPosition(blockId, offset);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => restoreReadingPosition(blockId, offset));
    }
  }

  function computeAndRecordProgress() {
    if (isRestoringScroll || !totalBlocks) return;

    const kids = streamEl.children;
    const n = kids.length;
    if (!n) return;

    // Blocks are in document order, so bottoms increase: binary-search the first one below the read line
    let lo = 0;
    let hi = n - 1;
    let idx = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid].getBoundingClientRect().bottom > READ_LINE) {
        idx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    const el = kids[idx];
    const rect = el.getBoundingClientRect();
    const rawOffset = (READ_LINE - rect.top) / Math.max(rect.height, 1);

    const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    const pct = Math.min(100, Math.max(0, (window.scrollY / maxScroll) * 100));

    currentBlockId = Number(el.dataset.blockId || idx);
    currentOffset = Math.max(0, Math.min(0.99, rawOffset));
    currentProgressPct = pct;
    progressEl.textContent = `${Math.round(pct)}%`;

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      postToHost({ action: "save_progress", ...progressPayload() });
    }, 250);
  }

  function scheduleProgress() {
    if (progressRaf) return;
    progressRaf = requestAnimationFrame(() => {
      progressRaf = 0;
      computeAndRecordProgress();
    });
  }

  window.addEventListener("scroll", scheduleProgress, { passive: true });

  // ------------------------------------------------------------------
  // Options panel
  // ------------------------------------------------------------------
  function setFontListOpen(open) {
    fontPick.classList.toggle("open", open);
    fontBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function setDropdownOpen(open) {
    dropdownEl.classList.toggle("open", open);
    dropdownEl.setAttribute("aria-hidden", open ? "false" : "true");
    hotspotEl.classList.toggle("menu-active", open);
    btnDropdown.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) setFontListOpen(false);
  }

  btnDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
    setDropdownOpen(!dropdownEl.classList.contains("open"));
  });

  document.addEventListener("click", (e) => {
    if (!hotspotEl.contains(e.target)) setDropdownOpen(false);
  });

  btnBack.addEventListener("click", () => {
    setDropdownOpen(false);
    postToHost({ action: "close_book", ...progressPayload() });
  });

  // Top-right corner
  btnFullscreen.addEventListener("click", () => postToHost({ action: "toggle_fullscreen" }));
  btnCloseApp.addEventListener("click", () => postToHost({ action: "close_app", ...progressPayload() }));

  // Theme
  document.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      applySettings({ theme: btn.getAttribute("data-theme-val") }, true);
    });
  });

  // Typeface picker
  fontBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setFontListOpen(!fontPick.classList.contains("open"));
  });

  fontOpts.forEach((opt) => {
    opt.tabIndex = 0;
    const choose = () => {
      withAnchor(() => applySettings({ font_family: opt.dataset.font }, true));
      setFontListOpen(false);
    };
    opt.addEventListener("click", choose);
    opt.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose();
      }
    });
  });

  // Text size and line width keep your place on screen while the text reflows
  $("btn-font-dec").addEventListener("click", () => {
    withAnchor(() => applySettings({ font_size: Math.max(14, settings.font_size - 1) }, true));
  });
  $("btn-font-inc").addEventListener("click", () => {
    withAnchor(() => applySettings({ font_size: Math.min(32, settings.font_size + 1) }, true));
  });
  $("btn-width-dec").addEventListener("click", () => {
    withAnchor(() => applySettings({ max_width: Math.max(46, settings.max_width - 4) }, true));
  });
  $("btn-width-inc").addEventListener("click", () => {
    withAnchor(() => applySettings({ max_width: Math.min(88, settings.max_width + 4) }, true));
  });

  // Sliders
  sliderWarmth.addEventListener("input", () => {
    applySettings({ warmth: Number(sliderWarmth.value) }, true);
  });
  sliderSaturation.addEventListener("input", () => {
    applySettings({ saturation: Number(sliderSaturation.value) }, true);
  });

  // Toggles
  toggleColorful.addEventListener("change", () => {
    applySettings({ colorful_images: toggleColorful.checked }, true);
  });
  toggleFast.addEventListener("change", () => {
    applySettings({ fast_reading: toggleFast.checked }, true);
  });
  strengthBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      applySettings({ fast_reading: true, fast_strength: Number(btn.dataset.strength) }, true);
    });
  });

  // B toggles fast reading
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "b" || e.key === "B") {
      applySettings({ fast_reading: !settings.fast_reading }, true);
    }
  });

  function setFullscreen(flag) {
    document.body.setAttribute("data-fullscreen", flag ? "true" : "false");
    btnFullscreen.title = flag ? "Exit fullscreen (F11)" : "Fullscreen (F11)";
  }

  // ------------------------------------------------------------------
  // Public API invoked by main.py
  // ------------------------------------------------------------------
  window.ReaditEngine = {
    loadBook(payload) {
      setDropdownOpen(false);
      const book = payload.book || {};
      const blocks = payload.blocks || [];
      totalBlocks = blocks.length;

      titleEl.textContent = book.title || "Book";
      if (payload.settings) applySettings(payload.settings, false);
      setFullscreen(Boolean(payload.fullscreen));

      renderBlocks(blocks);
      setupFastObserver();

      currentBlockId = Number(book.current_block || 0);
      currentOffset = Number(book.current_offset || 0.0);
      currentProgressPct = Number(book.progress_pct || 0.0);
      progressEl.textContent = `${Math.round(currentProgressPct)}%`;

      restoreReadingPosition(currentBlockId, currentOffset);
    },

    applySettings(newSettings) {
      withAnchor(() => applySettings(newSettings, false));
    },

    setFullscreen,
  };

  applySettings({}, false);
})();