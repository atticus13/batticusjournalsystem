/* Journal page logic. Reads data/data.json and builds a day or week view,
 * plus plain text ready to paste into Apple Journal.
 * Pure functions are exported for testing under Node. */
(function (root) {
  "use strict";

  // ------------------------------------------------------------- dates
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (s, n) => {
    const d = parseYmd(s);
    d.setDate(d.getDate() + n);
    return ymd(d);
  };
  const weekStart = (s) => addDays(s, -((parseYmd(s).getDay() + 6) % 7)); // Monday
  const rangeDays = (mode, s) =>
    mode === "day" ? [s] : Array.from({ length: 7 }, (_, i) => addDays(weekStart(s), i));
  const longDate = (s) =>
    parseYmd(s).toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
    });
  // Date-only strings stay as they are; full timestamps become the viewer's local day.
  const localDateOf = (iso) => {
    if (!iso) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const d = new Date(iso);
    return isNaN(d) ? null : ymd(d);
  };

  // --------------------------------------------------------- formatting
  const stars = (r) => {
    if (r == null || isNaN(r) || r <= 0) return "";
    const full = Math.floor(r);
    return "★".repeat(full) + (r - full >= 0.5 ? "½" : "");
  };
  const prettyType = (t) => {
    const s = (t || "Workout").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const fmtDuration = (sec) => {
    if (!sec) return "";
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  };
  const fmtMiles = (meters) => {
    if (!meters || meters <= 0) return "";
    const mi = meters * 0.000621371;
    return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  };

  // min:sec per mile; blank if the distance is too short to mean anything
  const fmtPace = (meters, sec) => {
    if (!meters || !sec || meters < 400) return "";
    const spm = sec / (meters * 0.000621371);
    let m = Math.floor(spm / 60), r = Math.round(spm % 60);
    if (r === 60) { m += 1; r = 0; }
    return `${m}:${pad(r)}/mi pace`;
  };
  // Optional display names for Letterboxd tags, e.g. { alexf: "Alex F." }
  const TAG_NAMES = {};
  const withList = (tags) =>
    (tags || []).map((t) => TAG_NAMES[t] || t.charAt(0).toUpperCase() + t.slice(1)).join(", ");
  const workoutDetails = (w) =>
    [w.distance, w.duration, w.pace, w.avgHr ? `avg HR ${w.avgHr} bpm` : ""].filter(Boolean);

  // ----------------------------------------------------------- gathering
  function collectDay(data, day) {
    const movies = (data.movies || []).filter((m) => m.watched_date === day);

    const workouts = (data.workouts || [])
      .filter((w) => (w.start_local || "").slice(0, 10) === day)
      .sort((a, b) => a.start_local.localeCompare(b.start_local))
      .map((w) => ({
        type: prettyType(w.type),
        distance: fmtMiles(w.distance_m),
        duration: fmtDuration(w.moving_time_s),
        pace: /^(run|trail run|virtual run)$/i.test(prettyType(w.type)) ? fmtPace(w.distance_m, w.moving_time_s) : "",
        avgHr: w.avg_hr ? Math.round(w.avg_hr) : null,
      }));

    const books = [];
    for (const b of data.books || []) {
      const reads = b.reads || [];
      let event = null;
      for (const r of reads) {
        if (localDateOf(r.finished_at) === day) event = "finished";
        else if (localDateOf(r.started_at) === day && event !== "finished") event = "started";
      }
      if (!event && b.reviewed_at && localDateOf(b.reviewed_at) === day) event = "reviewed";
      if (!event && localDateOf(b.updated_at) === day) event = "reading";
      if (!event) continue;
      const withPages = reads.filter((r) => r.progress_pages);
      books.push({
        title: b.title,
        authors: b.authors || [],
        rating: b.rating,
        review: b.review || "",
        event,
        pages: withPages.length ? withPages[withPages.length - 1].progress_pages : null,
      });
    }
    return { day, movies, books, workouts };
  }

  const summarize = (data, days) => days.map((d) => collectDay(data, d));
  const isEmpty = (b) => !b.movies.length && !b.books.length && !b.workouts.length;

  // ------------------------------------------------------- journal text
  const indent = (text) =>
    text.split("\n").map((l) => (l ? "  " + l : "")).join("\n");

  function movieLine(m) {
    const name = m.year ? `${m.title} (${m.year})` : m.title;
    const tail = [stars(m.rating), m.rewatch ? "(rewatch)" : "", m.tags && m.tags.length ? `(with ${withList(m.tags)})` : ""]
      .filter(Boolean).join(" ");
    return { name, tail };
  }

  const PLAIN = { b: (t) => t, i: (t) => t, esc: (t) => t, nl: "\n", ind: "  ", para: "\n" };
  const RICH = {
    b: (t) => `<b>${t}</b>`,
    i: (t) => `<i>${t}</i>`,
    esc: (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    nl: "<br>", ind: "&nbsp;&nbsp;", para: "<br>",
  };

  // Day heading and "Movie review:" style labels are bold; film and book titles are italic.
  function renderJournal(blocks, opts, f) {
    const includeReviews = !opts || opts.includeReviews !== false;
    const e = f.esc;
    const reviewText = (text) =>
      text.split("\n").map((l) => (l ? f.ind + e(l) : "")).join(f.nl);
    const out = [];
    for (const b of blocks) {
      if (isEmpty(b)) continue;
      const lines = [f.b(e(longDate(b.day)))];

      for (const m of b.movies) {
        const title = f.i(e(m.title)) + (m.year ? e(` (${m.year})`) : "");
        const tail = [stars(m.rating), m.rewatch ? "(rewatch)" : "", m.tags && m.tags.length ? `(with ${withList(m.tags)})` : ""]
          .filter(Boolean).join(" ");
        const suffix = tail ? " " + e(tail) : "";
        if (m.review) {
          lines.push(`- ${f.b("Movie review:")} ${title}${suffix}`);
          if (includeReviews) lines.push(reviewText(m.review));
        } else {
          lines.push(`- ${f.b("Watched:")} ${title}${suffix}`);
        }
      }

      for (const k of b.books) {
        const by = k.authors.length ? e(` by ${k.authors.join(", ")}`) : "";
        const rate = stars(k.rating) ? " " + e(stars(k.rating)) : "";
        const title = f.i(e(k.title));
        if (k.review && (k.event === "reviewed" || k.event === "finished")) {
          const fin = k.event === "finished" ? " (finished)" : "";
          lines.push(`- ${f.b("Book review:")} ${title}${by}${rate}${fin}`);
          if (includeReviews) lines.push(reviewText(k.review));
        } else if (k.event === "finished") {
          lines.push(`- ${f.b("Finished reading:")} ${title}${by}${rate}`);
        } else if (k.event === "started") {
          lines.push(`- ${f.b("Started reading:")} ${title}${by}`);
        } else {
          const pg = k.pages ? e(` (page ${k.pages})`) : "";
          lines.push(`- ${f.b("Reading:")} ${title}${by}${pg}`);
        }
      }

      for (const w of b.workouts) {
        const parts = workoutDetails(w);
        lines.push(`- ${f.b("Workout:")} ${e(w.type)}${parts.length ? e(` (${parts.join(", ")})`) : ""}`);
      }
      out.push(lines.join(f.nl));
    }
    if (!out.length) {
      return e(blocks.length === 1
        ? `Nothing logged for ${longDate(blocks[0].day)}.`
        : "Nothing logged for this week.");
    }
    return out.join(f.nl + f.para);
  }

  const toJournalText = (blocks, opts) => renderJournal(blocks, opts, PLAIN);
  const toJournalHtml = (blocks, opts) => renderJournal(blocks, opts, RICH);

  const api = {
    ymd, parseYmd, addDays, weekStart, rangeDays, longDate, localDateOf,
    stars, prettyType, fmtDuration, fmtMiles,
    collectDay, summarize, isEmpty, toJournalText, toJournalHtml, fmtPace,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  // ------------------------------------------------------------------ UI
  if (typeof document === "undefined") return;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function init() {
    const $ = (id) => document.getElementById(id);
    const state = {
      data: null,       // fetched only after the first tap on Show
      loading: false,
      mode: "day",      // pending selection (what the controls say)
      date: ymd(new Date()),
      shown: null,      // {mode, date} actually displayed
      includeReviews: true,
    };

    const rangeText = (mode, date) => {
      const days = rangeDays(mode, date);
      return mode === "day"
        ? longDate(date)
        : `${longDate(days[0]).replace(/^\w+, /, "")} to ${longDate(days[6]).replace(/^\w+, /, "")}`;
    };

    // Controls only update the selection; nothing is looked up until Show.
    function syncControls() {
      $("range-label").textContent = rangeText(state.mode, state.date);
      $("date-input").value = state.date;
      $("tab-day").setAttribute("aria-pressed", String(state.mode === "day"));
      $("tab-week").setAttribute("aria-pressed", String(state.mode === "week"));
      const stale = !state.shown || state.shown.mode !== state.mode || state.shown.date !== state.date;
      $("show").disabled = state.loading;
      $("show").textContent = state.shown && !stale ? "Showing" : "Show";
      $("entries").classList.toggle("stale", !!state.shown && stale);
    }

    function batStart() {
      $("entries").replaceChildren(el("p", "empty", "Fetching your data…"));
    }
    function batStop() {}

    function render() {
      syncControls();
      const data = state.data;
      if (!data || !state.shown) return;
      const { mode, date } = state.shown;
      const days = rangeDays(mode, date);
      const blocks = summarize(data, days);

      const list = $("entries");
      list.replaceChildren();
      let any = false;

      for (const b of blocks) {
        if (isEmpty(b)) continue;
        any = true;
        const card = el("section", "card");
        if (mode === "week") card.appendChild(el("h2", "day-title", longDate(b.day)));

        for (const m of b.movies) {
          const { name, tail } = movieLine(m);
          const row = el("div", "item");
          row.appendChild(el("span", "tag movie", m.review ? "Movie review" : "Watched"));
          row.appendChild(el("div", "title", name + (tail ? "  " + tail : "")));
          if (m.review) row.appendChild(el("p", "review", m.review));
          card.appendChild(row);
        }
        for (const k of b.books) {
          const by = k.authors.length ? ` by ${k.authors.join(", ")}` : "";
          const label = { finished: "Finished", started: "Started", reviewed: "Book review", reading: "Reading" }[k.event];
          const row = el("div", "item");
          row.appendChild(el("span", "tag book", label));
          const pg = k.event === "reading" && k.pages ? `  (page ${k.pages})` : "";
          row.appendChild(el("div", "title", `${k.title}${by}${stars(k.rating) ? "  " + stars(k.rating) : ""}${pg}`));
          if (k.review && (k.event === "reviewed" || k.event === "finished")) row.appendChild(el("p", "review", k.review));
          card.appendChild(row);
        }
        for (const w of b.workouts) {
          const parts = workoutDetails(w);
          const row = el("div", "item");
          row.appendChild(el("span", "tag workout", "Workout"));
          row.appendChild(el("div", "title", `${w.type}${parts.length ? "  (" + parts.join(", ") + ")" : ""}`));
          card.appendChild(row);
        }
        list.appendChild(card);
      }
      if (!any) list.appendChild(el("p", "empty", mode === "day" ? "Nothing logged for this day." : "Nothing logged for this week."));

      $("journal-text").textContent = toJournalText(blocks, { includeReviews: state.includeReviews });
      state.html = toJournalHtml(blocks, { includeReviews: state.includeReviews });
    }

    function status() {
      const d = state.data;
      const bits = [];
      if (d.generated_at) {
        bits.push("Updated " + new Date(d.generated_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }));
      }
      const bad = Object.entries(d.sources || {}).filter(([, v]) => v !== "ok");
      $("status").textContent = bits.join(" · ");
      if (bad.length) {
        $("warning").hidden = false;
        $("warning").textContent = "Not updating right now: " + bad.map(([k]) => k).join(", ") + ". Showing the last saved data.";
      }
    }

    async function copyText(text, html) {
      try {
        if (html && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          })]);
        } else {
          await navigator.clipboard.writeText(text);
        }
        return true;
      } catch (_) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0;";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch (_) { /* ignore */ }
        document.body.removeChild(ta);
        return ok;
      }
    }

    let toastTimer;
    function toast(msg) {
      const t = $("toast");
      t.textContent = msg;
      t.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
    }

    const move = (n) => {
      state.date = addDays(state.date, state.mode === "day" ? n : n * 7);
      syncControls();
    };
    $("prev").addEventListener("click", () => move(-1));
    $("next").addEventListener("click", () => move(1));
    $("today").addEventListener("click", () => { state.date = ymd(new Date()); syncControls(); });
    $("date-input").addEventListener("change", (e) => { if (e.target.value) { state.date = e.target.value; syncControls(); } });
    $("tab-day").addEventListener("click", () => { state.mode = "day"; syncControls(); });
    $("tab-week").addEventListener("click", () => { state.mode = "week"; syncControls(); });
    $("include-reviews").addEventListener("change", (e) => { state.includeReviews = e.target.checked; render(); });
    $("copy").addEventListener("click", async () => {
      if (!state.shown) { toast("Pick a date and tap Show first."); return; }
      const ok = await copyText($("journal-text").textContent, state.html);
      toast(ok ? "Copied. Paste it into Apple Journal." : "Couldn't copy. Open 'Text to paste' and copy it by hand.");
    });

    async function show() {
      if (state.loading) return;
      if (!state.data) {
        state.loading = true;
        syncControls();
        batStart();
        try {
          const r = await fetch("data/data.json?t=" + Date.now());
          if (!r.ok) throw new Error("HTTP " + r.status);
          state.data = await r.json();
          status();
        } catch (e) {
          batStop();
          state.loading = false;
          syncControls();
          $("entries").replaceChildren(el("p", "empty", "Couldn't load your data (" + e.message + "). Tap Show to try again."));
          return;
        }
        batStop();
        state.loading = false;
      }
      state.shown = { mode: state.mode, date: state.date };
      render();
    }
    $("show").addEventListener("click", () => {
      show().catch((e) => {
        state.loading = false;
        batStop();
        $("entries").replaceChildren(el("p", "empty", "Something went wrong: " + (e && e.message ? e.message : e)));
      });
    });

    syncControls();
    $("entries").replaceChildren(el("p", "empty", "Pick a day or week, then tap Show."));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(typeof window !== "undefined" ? window : globalThis);
