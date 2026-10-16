(() => {
  const streamEl = document.getElementById("book-stream");
  const hotspotLeft = document.getElementById("top-left-hotspot");
  const dropdownEl = document.getElementById("reader-dropdown");
  const btnBack = document.getElementById("btn-back");
  const btnDropdown = document.getElementById("btn-dropdown");

  const btnMaximize = document.getElementById("btn-maximize");
  const btnFullscreen = document.getElementById("btn-fullscreen");
  const btnCloseApp = document.getElementById("btn-close-app");

  const titleEl = document.getElementById("dropdown-book-title");
  const progressEl = document.getElementById("dropdown-progress");

  const fontpickEl = document.getElementById("fontpick");
  const fontpickBtn = document.getElementById("fontpick-btn");
  const fontpickCurrent = document.getElementById("fontpick-current");
  const fontpickOpts = document.querySelectorAll(".fp-opt");

  const valFontSize = document.getElementById("val-font-size");
  const valWidth = document.getElementById("val-width");
  const sliderWarmth = document.getElementById("slider-warmth");
  const valWarmth = document.getElementById("val-warmth");
  const sliderSaturation = document.getElementById("slider-saturation");
  const valSaturation = document.getElementById("val-saturation");
  const toggleColorful = document.getElementById("toggle-colorful");
  const toggleFast = document.getElementById("toggle-fast");
  const strengthBtns = document.querySelectorAll("#fast-strength button");

  const selPopover = document.getElementById("selection-popover");
  const btnSelDict = document.getElementById("btn-sel-dict");
  const btnSelAi = document.getElementById("btn-sel-ai");
  const btnSelGoogle = document.getElementById("btn-sel-google");
  const btnSelCopy = document.getElementById("btn-sel-copy");
  const selCard = document.getElementById("sel-card");
  const selCardTitle = document.getElementById("sel-card-title");
  const selCardPhonetic = document.getElementById("sel-card-phonetic");
  const selCardBadge = document.getElementById("sel-card-badge");
  const selCardBody = document.getElementById("sel-card-body");
  const selCardExample = document.getElementById("sel-card-example");

  let currentBook = null;
  let totalBlocks = 0;
  let currentBlockId = 0;
  let currentOffset = 0.0;
  let currentProgressPct = 0.0;
  let isRestoringScroll = false;
  let scrollRafPending = false;
  let saveTimer = null;

  let bionicObserver = null;
  let lookupReqCounter = 1;
  let activeSelectionText = "";
  let activeSelectionContext = "";

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
    if (window.webkit?.messageHandlers?.readit) {
      window.webkit.messageHandlers.readit.postMessage(JSON.stringify(payload));
    }
  }

  function updateKelvinWarmth(warmthVal) {
    const w = Math.max(0, Math.min(100, Number(warmthVal) || 0)) / 100;
    if (w <= 0.005) {
      document.documentElement.style.setProperty("--warmth-strength", "0");
      return;
    }
    document.documentElement.style.setProperty("--warmth-strength", (w * 0.24).toFixed(3));
  }

  // Fast Reading (Lazy Bionic Highlighter)
  const WORD_RE = /([\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*)/gu;

  function boldCountForWord(len, strength) {
    if (len <= 1) return 1;
    if (len <= 3) return strength >= 3 ? 2 : 1;
    const ratio = strength === 1 ? 0.32 : strength === 3 ? 0.56 : 0.44;
    return Math.max(1, Math.min(len - 1, Math.round(len * ratio)));
  }

  function formatBionicHTML(text, strength) {
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return escaped.replace(WORD_RE, (word) => {
      const k = boldCountForWord(word.length, strength);
      return `<b class="bf">${word.slice(0, k)}</b>${word.slice(k)}`;
    });
  }

  function applyBionicToElement(el) {
    if (!el || el.classList.contains("book-illustration-wrap") || el.classList.contains("toc")) return;
    const strength = Number(settings.fast_strength) || 2;
    if (el.dataset.bionicApplied === String(strength)) return;

    const target = el.classList.contains("li") ? el.querySelector(".li-text") : el;
    if (target) {
      const raw = target.dataset.rawText ?? target.textContent;
      target.dataset.rawText = raw;
      target.innerHTML = formatBionicHTML(raw, strength);
      target.classList.add("bionic-done");
      el.dataset.bionicApplied = String(strength);
    }
  }

  function stripBionicFromAll() {
    if (bionicObserver) {
      bionicObserver.disconnect();
      bionicObserver = null;
    }
    streamEl.querySelectorAll("[data-bionic-applied]").forEach((el) => {
      const target = el.classList.contains("li") ? el.querySelector(".li-text") : el;
      if (target && target.dataset.rawText !== undefined) {
        target.textContent = target.dataset.rawText;
        target.classList.remove("bionic-done");
      }
      delete el.dataset.bionicApplied;
    });
  }

  function rebuildBionicObserver() {
    if (bionicObserver) {
      bionicObserver.disconnect();
      bionicObserver = null;
    }
    if (!settings.fast_reading) {
      stripBionicFromAll();
      return;
    }
    bionicObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) applyBionicToElement(entry.target);
        }
      },
      { rootMargin: "600px 0px 600px 0px" }
    );
    Array.from(streamEl.children).forEach((child) => {
      if (!child.classList.contains("book-illustration-wrap")) {
        bionicObserver.observe(child);
      }
    });
  }

  function applySettings(newSettings, persist = false) {
    const prevFast = settings.fast_reading;
    const prevStrength = settings.fast_strength;
    settings = { ...settings, ...newSettings };

    document.body.setAttribute("data-theme", settings.theme);
    document.body.setAttribute("data-font", settings.font_family);
    document.body.setAttribute("data-colorful", settings.colorful_images ? "true" : "false");
    document.body.setAttribute("data-fast", settings.fast_reading ? "true" : "false");

    const sat = Number(settings.saturation ?? 100);
    document.documentElement.style.setProperty("--reader-saturation", `${sat}%`);
    document.documentElement.style.setProperty("--reader-font-size", `${settings.font_size}px`);
    document.documentElement.style.setProperty("--reader-max-width", `${settings.max_width}ch`);

    updateKelvinWarmth(settings.warmth);

    document.querySelectorAll(".theme-swatch").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-theme-val") === settings.theme);
    });

    fontpickOpts.forEach((opt) => {
      const isMatch = opt.dataset.font === settings.font_family;
      opt.classList.toggle("active", isMatch);
      if (isMatch) fontpickCurrent.textContent = opt.dataset.label;
    });

    valFontSize.textContent = `${settings.font_size}px`;
    valWidth.textContent = `${settings.max_width}ch`;
    sliderWarmth.value = settings.warmth;
    valWarmth.textContent = `${settings.warmth}%`;
    sliderSaturation.value = sat;
    valSaturation.textContent = `${sat}%`;
    toggleColorful.checked = Boolean(settings.colorful_images);
    toggleFast.checked = Boolean(settings.fast_reading);

    strengthBtns.forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.strength) === Number(settings.fast_strength));
    });

    if (prevFast !== settings.fast_reading || prevStrength !== settings.fast_strength) {
      rebuildBionicObserver();
    }
    if (persist) {
      postToHost({ action: "save_settings", settings });
    }
  }

  function renderBlocks(blocks) {
    if (bionicObserver) {
      bionicObserver.disconnect();
      bionicObserver = null;
    }
    streamEl.innerHTML = "";
    const frag = document.createDocumentFragment();

    for (const blk of blocks) {
      if (blk.type === "img") {
        const wrap = document.createElement("figure");
        wrap.className = "book-illustration-wrap";
        wrap.dataset.blockId = blk.id;

        const img = document.createElement("img");
        img.className = "book-illustration";
        img.src = blk.src;
        if (blk.width && blk.height) {
          img.width = blk.width;
          img.height = blk.height;
        }
        img.loading = "lazy";
        img.decoding = "async";
        wrap.appendChild(img);
        frag.appendChild(wrap);
      } else if (blk.type === "toc") {
        const row = document.createElement("div");
        row.className = `toc ${blk.level === 1 ? "toc-l1" : "toc-l2"} ${!blk.page ? "toc-nopage" : ""}`.trim();
        row.dataset.blockId = blk.id;

        const tSpan = document.createElement("span");
        tSpan.className = "toc-title";
        tSpan.textContent = blk.text;
        const fillSpan = document.createElement("span");
        fillSpan.className = "toc-fill";
        const pSpan = document.createElement("span");
        pSpan.className = "toc-page";
        pSpan.textContent = blk.page || "";

        row.append(tSpan, fillSpan, pSpan);
        frag.appendChild(row);
      } else if (blk.type === "li") {
        const row = document.createElement("div");
        row.className = "li";
        row.dataset.blockId = blk.id;

        const mark = document.createElement("span");
        mark.className = "li-mark";
        mark.textContent = blk.marker || "•";
        const txt = document.createElement("span");
        txt.className = "li-text";
        txt.textContent = blk.text;
        txt.dataset.rawText = blk.text;

        row.append(mark, txt);
        frag.appendChild(row);
      } else if (blk.type === "lines") {
        const div = document.createElement("div");
        div.className = "lines";
        div.dataset.blockId = blk.id;
        div.textContent = blk.text;
        div.dataset.rawText = blk.text;
        frag.appendChild(div);
      } else {
        const tag = blk.type === "h1" || blk.type === "h2" ? blk.type : "p";
        const el = document.createElement(tag);
        el.dataset.blockId = blk.id;
        el.textContent = blk.text;
        el.dataset.rawText = blk.text;
        frag.appendChild(el);
      }
    }

    streamEl.appendChild(frag);
    if (settings.fast_reading) rebuildBionicObserver();
  }

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
      }, 100);
    });
  }

  function computeAndRecordProgress() {
    scrollRafPending = false;
    if (isRestoringScroll || !totalBlocks) return;

    const children = streamEl.children;
    let foundId = currentBlockId;
    let foundOffset = 0.0;

    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 48) {
        foundId = Number(el.dataset.blockId || i);
        const rawOffset = (48 - rect.top) / Math.max(rect.height, 1);
        foundOffset = Math.max(0, Math.min(0.99, rawOffset));
        break;
      }
    }

    const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    const pct = Math.min(100, Math.max(0, (window.scrollY / maxScroll) * 100));

    currentBlockId = foundId;
    currentOffset = foundOffset;
    currentProgressPct = pct;
    progressEl.textContent = `${Math.round(pct)}%`;

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      postToHost({
        action: "save_progress",
        block_id: currentBlockId,
        offset: currentOffset,
        progress_pct: currentProgressPct,
      });
    }, 300);
  }

  window.addEventListener(
    "scroll",
    () => {
      if (selPopover.classList.contains("open")) hideSelectionPopover();
      if (!scrollRafPending) {
        scrollRafPending = true;
        requestAnimationFrame(computeAndRecordProgress);
      }
    },
    { passive: true }
  );

  function hideSelectionPopover() {
    selPopover.classList.remove("open");
    selPopover.setAttribute("aria-hidden", "true");
    selCard.hidden = true;
    btnSelDict.classList.remove("active");
    btnSelAi.classList.remove("active");
  }

  function positionSelectionPopover(rect) {
    const popRect = selPopover.getBoundingClientRect();
    const popW = popRect.width || 290;
    const popH = popRect.height || 44;

    let left = rect.left + rect.width / 2 - popW / 2;
    left = Math.max(12, Math.min(window.innerWidth - popW - 12, left));

    let top = rect.top - popH - 10;
    if (top < 14) top = rect.bottom + 10;

    selPopover.style.left = `${Math.round(left)}px`;
    selPopover.style.top = `${Math.round(top)}px`;
  }

  function handleTextSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      hideSelectionPopover();
      return;
    }
    const text = sel.toString().trim();
    if (text.length < 2 || text.length > 420) {
      hideSelectionPopover();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!streamEl.contains(range.commonAncestorContainer)) {
      hideSelectionPopover();
      return;
    }

    activeSelectionText = text;
    const blockEl =
      range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer.closest("[data-block-id]")
        : range.commonAncestorContainer.parentElement?.closest("[data-block-id]");
    activeSelectionContext = blockEl
      ? (blockEl.dataset.rawText || blockEl.textContent || "").trim()
      : text;

    selCard.hidden = true;
    btnSelDict.classList.remove("active");
    btnSelAi.classList.remove("active");

    const rect = range.getBoundingClientRect();
    selPopover.classList.add("open");
    selPopover.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => positionSelectionPopover(rect));
  }

  streamEl.addEventListener("mouseup", () => setTimeout(handleTextSelection, 20));
  streamEl.addEventListener("keyup", () => setTimeout(handleTextSelection, 20));

  function triggerLookup(mode) {
    if (!activeSelectionText) return;
    lookupReqCounter += 1;
    btnSelDict.classList.toggle("active", mode === "dict");
    btnSelAi.classList.toggle("active", mode === "ai");

    selCard.hidden = false;
    selCardTitle.textContent = activeSelectionText.slice(0, 42);
    selCardPhonetic.textContent = "";
    selCardBadge.textContent = mode === "dict" ? "Dictionary" : "AI Thinking…";
    selCardBody.textContent =
      mode === "dict" ? "Looking up definition…" : "Analyzing meaning in book context…";
    selCardExample.hidden = true;

    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      requestAnimationFrame(() => positionSelectionPopover(rect));
    }

    postToHost({
      action: "lookup_selection",
      req_id: lookupReqCounter,
      text: activeSelectionText,
      context: activeSelectionContext,
      mode,
    });
  }

  btnSelDict.addEventListener("click", (e) => { e.stopPropagation(); triggerLookup("dict"); });
  btnSelAi.addEventListener("click", (e) => { e.stopPropagation(); triggerLookup("ai"); });
  btnSelGoogle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!activeSelectionText) return;
    postToHost({
      action: "open_google_ai",
      text: activeSelectionText,
      context: activeSelectionContext,
    });
    hideSelectionPopover();
  });
  btnSelCopy.addEventListener("click", (e) => {
    e.stopPropagation();
    if (activeSelectionText && navigator.clipboard) {
      navigator.clipboard.writeText(activeSelectionText);
    }
    hideSelectionPopover();
  });

  function closeDropdown() {
    dropdownEl.classList.remove("open");
    dropdownEl.setAttribute("aria-hidden", "true");
    btnDropdown.setAttribute("aria-expanded", "false");
    hotspotLeft.classList.remove("menu-active");
    fontpickEl.classList.remove("open");
    fontpickBtn.setAttribute("aria-expanded", "false");
  }

  btnDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = dropdownEl.classList.toggle("open");
    dropdownEl.setAttribute("aria-hidden", String(!isOpen));
    btnDropdown.setAttribute("aria-expanded", String(isOpen));
    hotspotLeft.classList.toggle("menu-active", isOpen);
  });

  fontpickBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = fontpickEl.classList.toggle("open");
    fontpickBtn.setAttribute("aria-expanded", String(open));
  });

  fontpickOpts.forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      applySettings({ font_family: opt.dataset.font }, true);
      fontpickEl.classList.remove("open");
      fontpickBtn.setAttribute("aria-expanded", "false");
    });
  });

  document.addEventListener("mousedown", (e) => {
    if (!hotspotLeft.contains(e.target)) closeDropdown();
    if (selPopover.classList.contains("open") && !selPopover.contains(e.target)) {
      hideSelectionPopover();
    }
  });

  btnBack.addEventListener("click", () => {
    closeDropdown();
    postToHost({
      action: "close_book",
      block_id: currentBlockId,
      offset: currentOffset,
      progress_pct: currentProgressPct,
    });
  });

  btnMaximize.addEventListener("click", () => postToHost({ action: "toggle_maximize" }));
  btnFullscreen.addEventListener("click", () => postToHost({ action: "toggle_fullscreen" }));
  btnCloseApp.addEventListener("click", () => {
    postToHost({
      action: "close_app",
      block_id: currentBlockId,
      offset: currentOffset,
      progress_pct: currentProgressPct,
    });
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "b" || e.key === "B") {
      applySettings({ fast_reading: !settings.fast_reading }, true);
    } else if (e.key === "m" || e.key === "M") {
      postToHost({ action: "toggle_maximize" });
    }
  });

  document.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      applySettings({ theme: btn.getAttribute("data-theme-val") }, true);
    });
  });

  document.getElementById("btn-font-dec").addEventListener("click", () => {
    const anchorBlock = currentBlockId;
    const anchorOffset = currentOffset;
    applySettings({ font_size: Math.max(14, settings.font_size - 1) }, true);
    restoreReadingPosition(anchorBlock, anchorOffset);
  });

  document.getElementById("btn-font-inc").addEventListener("click", () => {
    const anchorBlock = currentBlockId;
    const anchorOffset = currentOffset;
    applySettings({ font_size: Math.min(32, settings.font_size + 1) }, true);
    restoreReadingPosition(anchorBlock, anchorOffset);
  });

  document.getElementById("btn-width-dec").addEventListener("click", () => {
    applySettings({ max_width: Math.max(46, settings.max_width - 4) }, true);
  });

  document.getElementById("btn-width-inc").addEventListener("click", () => {
    applySettings({ max_width: Math.min(88, settings.max_width + 4) }, true);
  });

  sliderWarmth.addEventListener("input", () => {
    applySettings({ warmth: Number(sliderWarmth.value) }, true);
  });

  sliderSaturation.addEventListener("input", () => {
    applySettings({ saturation: Number(sliderSaturation.value) }, true);
  });

  toggleColorful.addEventListener("change", () => {
    applySettings({ colorful_images: toggleColorful.checked }, true);
  });

  toggleFast.addEventListener("change", () => {
    applySettings({ fast_reading: toggleFast.checked }, true);
  });

  strengthBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      applySettings({ fast_strength: Number(btn.dataset.strength) }, true);
    });
  });

  window.ReaditEngine = {
    loadBook(payload) {
      closeDropdown();
      hideSelectionPopover();
      currentBook = payload.book || {};
      const blocks = payload.blocks || [];
      totalBlocks = blocks.length;

      titleEl.textContent = currentBook.title || "Book";
      if (payload.settings) applySettings(payload.settings, false);

      document.body.setAttribute("data-fullscreen", payload.fullscreen ? "true" : "false");
      document.body.setAttribute("data-maximized", payload.maximized ? "true" : "false");

      renderBlocks(blocks);

      currentBlockId = Number(currentBook.current_block || 0);
      currentOffset = Number(currentBook.current_offset || 0.0);
      currentProgressPct = Number(currentBook.progress_pct || 0.0);
      progressEl.textContent = `${Math.round(currentProgressPct)}%`;

      restoreReadingPosition(currentBlockId, currentOffset);
    },
    applySettings(newSettings) {
      applySettings(newSettings, false);
    },
    setWindowState(state) {
      if (!state) return;
      if (typeof state.fullscreen === "boolean") {
        document.body.setAttribute("data-fullscreen", state.fullscreen ? "true" : "false");
      }
      if (typeof state.maximized === "boolean") {
        document.body.setAttribute("data-maximized", state.maximized ? "true" : "false");
      }
    },
    onLookupResult(res) {
      if (!res || Number(res.req_id) !== lookupReqCounter) return;
      selCard.hidden = false;
      selCardTitle.textContent = res.title || activeSelectionText.slice(0, 42);
      selCardPhonetic.textContent = res.phonetic || "";
      selCardBadge.textContent = res.badge || (res.mode === "dict" ? "Dictionary" : "AI");
      selCardBody.textContent = res.body || "";
      if (res.example) {
        selCardExample.textContent = res.example;
        selCardExample.hidden = false;
      } else {
        selCardExample.hidden = true;
      }
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        requestAnimationFrame(() => positionSelectionPopover(rect));
      }
    },
  };
})();