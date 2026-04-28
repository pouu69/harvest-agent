/* Harvest pitch deck — navigation + chrome sync.
   Vanilla JS, no dependencies. Single file. */

(function () {
  "use strict";

  const deck      = document.getElementById("deck");
  const slides    = Array.from(document.querySelectorAll(".slide"));
  const total     = slides.length;
  const chromeNum = document.querySelector(".chrome__num");
  const chromeName= document.querySelector(".chrome__name");
  const chromeTotal = document.querySelector(".chrome__total");
  const progressFill = document.querySelector(".progress__fill");
  const btnPrev   = document.querySelector('[data-nav="prev"]');
  const btnNext   = document.querySelector('[data-nav="next"]');

  let current = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function pad(n) { return String(n).padStart(2, "0"); }

  function go(n, opts) {
    const next = Math.max(0, Math.min(total - 1, n));
    if (next === current && opts && opts.silent) return;
    current = next;
    deck.style.transform = `translateX(${-current * 100}vw)`;
    slides.forEach((s, i) => s.classList.toggle("is-active", i === current));
    chromeNum.textContent = pad(current + 1);
    chromeName.textContent = slides[current].dataset.name || "";
    progressFill.style.width = `${((current + 1) / total) * 100}%`;
    btnPrev.toggleAttribute("disabled", current === 0);
    btnNext.toggleAttribute("disabled", current === total - 1);
    history.replaceState(null, "", `#${pad(current + 1)}`);
    runCountUp(slides[current]);
  }

  function next() { go(current + 1); }
  function prev() { go(current - 1); }

  /* ---------- count-up for numeric data-count nodes ----------
     Used on slide 06 (.cap__num). Only runs once per element. */
  function runCountUp(slide) {
    const targets = slide.querySelectorAll("[data-count]:not([data-counted])");
    if (!targets.length) return;
    targets.forEach((el) => {
      el.dataset.counted = "1";
      if (reduced) return;
      const final = parseInt(el.dataset.count, 10);
      if (Number.isNaN(final)) return;
      const dur = 700;
      const start = performance.now();
      el.textContent = "0";
      function tick(t) {
        const k = Math.min(1, (t - start) / dur);
        const eased = 1 - Math.pow(1 - k, 3); /* easeOutCubic */
        el.textContent = String(Math.round(final * eased));
        if (k < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowRight":
      case "PageDown":
      case " ":
        e.preventDefault(); next(); break;
      case "ArrowLeft":
      case "PageUp":
        e.preventDefault(); prev(); break;
      case "Home":
        e.preventDefault(); go(0); break;
      case "End":
        e.preventDefault(); go(total - 1); break;
      default:
        if (/^[1-9]$/.test(e.key)) { e.preventDefault(); go(parseInt(e.key, 10) - 1); }
    }
  });

  /* ---------- click zones ----------
     Right 30% advances, left 10% goes back. Buttons + interactive
     elements opt-out via the closest-check. */
  document.addEventListener("click", (e) => {
    if (e.target.closest("button, a, kbd, code, pre, .terminal, .nav")) return;
    const x = e.clientX / window.innerWidth;
    if (x > 0.7) next();
    else if (x < 0.1) prev();
  });

  btnPrev.addEventListener("click", prev);
  btnNext.addEventListener("click", next);

  /* ---------- touch ---------- */
  let tStart = null;
  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    tStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (!tStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - tStart.x;
    const dy = t.clientY - tStart.y;
    const dt = Date.now() - tStart.t;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 600) {
      if (dx < 0) next(); else prev();
    }
    tStart = null;
  }, { passive: true });

  /* ---------- wheel (horizontal trackpad swipes) ---------- */
  let wheelLock = false;
  document.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaX) < 40 || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.6) return;
    if (wheelLock) return;
    wheelLock = true;
    if (e.deltaX > 0) next(); else prev();
    setTimeout(() => { wheelLock = false; }, 700);
  }, { passive: true });

  /* ---------- hash deep-link ---------- */
  function fromHash() {
    const m = /^#(\d{1,2})$/.exec(window.location.hash);
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    return Math.max(1, Math.min(total, n)) - 1;
  }
  window.addEventListener("hashchange", () => go(fromHash(), { silent: false }));

  /* ---------- init ---------- */
  chromeTotal.textContent = pad(total);
  go(fromHash());
})();
