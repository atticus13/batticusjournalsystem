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
    const tail = [stars(m.rating), m.rewatch ? "(rewatch)" : ""].filter(Boolean).join(" ");
    return { name, tail };
  }

  function toJournalText(blocks, opts) {
    const includeReviews = !opts || opts.includeReviews !== false;
    const out = [];
    for (const b of blocks) {
      if (isEmpty(b)) continue;
      const lines = [longDate(b.day)];

      for (const m of b.movies) {
        const { name, tail } = movieLine(m);
        const suffix = tail ? " " + tail : "";
        if (m.review) {
          lines.push(`- Movie review: ${name}${suffix}`);
          if (includeReviews) lines.push(indent(m.review));
        } else {
          lines.push(`- Watched: ${name}${suffix}`);
        }
      }

      for (const k of b.books) {
        const by = k.authors.length ? ` by ${k.authors.join(", ")}` : "";
        const rate = stars(k.rating) ? " " + stars(k.rating) : "";
        if (k.review && (k.event === "reviewed" || k.event === "finished")) {
          const fin = k.event === "finished" ? " (finished)" : "";
          lines.push(`- Book review: ${k.title}${by}${rate}${fin}`);
          if (includeReviews) lines.push(indent(k.review));
        } else if (k.event === "finished") {
          lines.push(`- Finished reading: ${k.title}${by}${rate}`);
        } else if (k.event === "started") {
          lines.push(`- Started reading: ${k.title}${by}`);
        } else {
          const pg = k.pages ? ` (page ${k.pages})` : "";
          lines.push(`- Reading: ${k.title}${by}${pg}`);
        }
      }

      for (const w of b.workouts) {
        const parts = [w.distance, w.duration].filter(Boolean);
        lines.push(`- Workout: ${w.type}${parts.length ? ` (${parts.join(", ")})` : ""}`);
      }
      out.push(lines.join("\n"));
    }
    if (!out.length) {
      return blocks.length === 1
        ? `Nothing logged for ${longDate(blocks[0].day)}.`
        : "Nothing logged for this week.";
    }
    return out.join("\n\n");
  }

  const api = {
    ymd, parseYmd, addDays, weekStart, rangeDays, longDate, localDateOf,
    stars, prettyType, fmtDuration, fmtMiles,
    collectDay, summarize, isEmpty, toJournalText,
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
      data: null,
      mode: "day",
      date: ymd(new Date()),
      includeReviews: true,
    };

    function render() {
      const data = state.data;
      if (!data) return;
      const days = rangeDays(state.mode, state.date);
      const blocks = summarize(data, days);

      $("range-label").textContent =
        state.mode === "day"
          ? longDate(state.date)
          : `${longDate(days[0]).replace(/^\w+, /, "")} to ${longDate(days[6]).replace(/^\w+, /, "")}`;
      $("date-input").value = state.date;
      $("tab-day").setAttribute("aria-pressed", String(state.mode === "day"));
      $("tab-week").setAttribute("aria-pressed", String(state.mode === "week"));

      const list = $("entries");
      list.replaceChildren();
      let any = false;

      for (const b of blocks) {
        if (isEmpty(b)) continue;
        any = true;
        const card = el("section", "card");
        if (state.mode === "week") card.appendChild(el("h2", "day-title", longDate(b.day)));

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
          const parts = [w.distance, w.duration].filter(Boolean);
          const row = el("div", "item");
          row.appendChild(el("span", "tag workout", "Workout"));
          row.appendChild(el("div", "title", `${w.type}${parts.length ? "  (" + parts.join(", ") + ")" : ""}`));
          card.appendChild(row);
        }
        list.appendChild(card);
      }
      if (!any) list.appendChild(el("p", "empty", state.mode === "day" ? "Nothing logged for this day." : "Nothing logged for this week."));

      $("journal-text").textContent = toJournalText(blocks, { includeReviews: state.includeReviews });
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

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
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
      render();
    };
    $("prev").addEventListener("click", () => move(-1));
    $("next").addEventListener("click", () => move(1));
    $("today").addEventListener("click", () => { state.date = ymd(new Date()); render(); });
    $("date-input").addEventListener("change", (e) => { if (e.target.value) { state.date = e.target.value; render(); } });
    $("tab-day").addEventListener("click", () => { state.mode = "day"; render(); });
    $("tab-week").addEventListener("click", () => { state.mode = "week"; render(); });
    $("include-reviews").addEventListener("change", (e) => { state.includeReviews = e.target.checked; render(); });
    $("copy").addEventListener("click", async () => {
      const ok = await copyText($("journal-text").textContent);
      toast(ok ? "Copied. Paste it into Apple Journal." : "Couldn't copy. Open 'Text to paste' and copy it by hand.");
    });

    fetch("data/data.json?t=" + Date.now())
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((d) => { state.data = d; status(); render(); })
      .catch((e) => {
        $("entries").replaceChildren(el("p", "empty", "Couldn't load your data (" + e.message + ")."));
      });
  }
})(typeof window !== "undefined" ? window : globalThis);
