/* =====================================================================
   LOCK.JS  -  "Lock In" focus lock

   - Editable minutes + Lock In button (bottom-right hover zone)
   - On lock: asks the host (main.py) to go fullscreen and refuse to
     close / go back / leave fullscreen until the time is up
   - While locked: back, close, fullscreen and maximize are disabled
     here too; reading controls keep working

   Load after reader.js:  <script src="lock.js"></script>
   ===================================================================== */
(() => {
  const MIN_MINUTES = 1;
  const MAX_MINUTES = 240;
  const DEFAULT_MINUTES = 5;
  const STORE_KEY = "readit.lockMinutes";

  const input = document.getElementById("lock-minutes");
  const btnLock = document.getElementById("btn-lock");
  const remainingEl = document.getElementById("lock-remaining");
  const unitEl = document.getElementById("lock-unit");

  // buttons that would let the reader escape
  const guarded = ["btn-back", "btn-close-app", "btn-fullscreen", "btn-maximize"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  let deadline = 0;
  let ticker = null;

  function postToHost(payload) {
    if (window.webkit?.messageHandlers?.readit) {
      window.webkit.messageHandlers.readit.postMessage(JSON.stringify(payload));
    }
  }

  /* ---------- minutes input ---------- */

  function clampMinutes(value) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return DEFAULT_MINUTES;
    return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n));
  }

  function fitInput() {
    input.style.width = `${Math.max(input.value.length, 1)}ch`;
  }

  function commitMinutes() {
    input.value = String(clampMinutes(input.value));
    fitInput();
    try {
      localStorage.setItem(STORE_KEY, input.value);
    } catch (_) {
      /* storage unavailable: fine, just don't remember it */
    }
  }

  function loadSavedMinutes() {
    let saved = DEFAULT_MINUTES;
    try {
      saved = clampMinutes(localStorage.getItem(STORE_KEY) ?? DEFAULT_MINUTES);
    } catch (_) {
      /* ignore */
    }
    input.value = String(saved);
    fitInput();
  }

  input.addEventListener("focus", () => input.select());

  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 3);
    fitInput();
  });

  input.addEventListener("blur", commitMinutes);

  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing here must never trigger reader shortcuts
    if (e.key === "Enter" || e.key === "Escape") {
      input.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const step = e.key === "ArrowUp" ? 1 : -1;
      input.value = String(clampMinutes(clampMinutes(input.value) + step));
      fitInput();
      input.select();
    }
  });

  /* ---------- countdown ---------- */

  function formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0
      ? { text: `${h}:${pad(m)}:${pad(s)}`, unit: "hr" }
      : { text: `${m}:${pad(s)}`, unit: "min" };
  }

  function render() {
    const left = deadline - Date.now();
    if (left <= 0) {
      endLock();
      return;
    }
    const { text, unit } = formatRemaining(left);
    remainingEl.textContent = text;
    unitEl.textContent = unit;
  }

  function setLocked(on) {
    document.body.dataset.locked = on ? "true" : "false";
    guarded.forEach((btn) => {
      btn.disabled = on;
    });
  }

  function startLock() {
    commitMinutes();
    const minutes = clampMinutes(input.value);

    deadline = Date.now() + minutes * 60 * 1000;
    setLocked(true);
    render();
    clearInterval(ticker);
    ticker = setInterval(render, 250);

    // host goes fullscreen and refuses close / back / unfullscreen
    postToHost({ action: "start_lock", seconds: minutes * 60 });
  }

  function endLock() {
    clearInterval(ticker);
    ticker = null;
    deadline = 0;
    setLocked(false);
  }

  btnLock.addEventListener("click", startLock);

  /* ---------- init ---------- */
  loadSavedMinutes();
  setLocked(false);
})();