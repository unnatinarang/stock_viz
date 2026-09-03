import { useState, useMemo } from "react";
import Papa from "papaparse";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot,
} from "recharts";

// ---------- Palette (Illinois teaching set) ----------
const BLUE = "#13294B";
const ORANGE = "#E84A27";
const INK = "#1F2A37";
const MUTED = "#6B7280";
const GREY_LINE = "#B8BEC7";
const PANEL = "#F3F5F9";
const RULE = "#DDE2EA";

// ---------- Simulated price engine ----------
const AI_TICKERS = new Set(["NVDA","MSFT","GOOGL","GOOG","META","AMD","PLTR","AVGO","TSM","ORCL","SMCI","ARM","ANET","CRWD","SNOW","AMZN","MRVL","ASML","MU"]);
const NON_AI_TICKERS = new Set(["KO","PG","JNJ","WMT","XOM","PEP","MCD","HD","CVX","T","VZ","KHC","CL","KMB","GIS","MO","PM","UNP","CAT","LOW"]);

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rng) {
  const u = Math.max(rng(), 1e-9), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const END = new Date(2026, 8, 1); // Sept 1, 2026
const YEARS = 5;
const DAYS = YEARS * 252;

// annual drift by calendar regime. AI names slump in 2022, surge 2023-24, cool 2025-26.
function driftFor(date, isAI, rng0) {
  const y = date.getFullYear();
  if (isAI) {
    if (y <= 2021) return 0.30;
    if (y === 2022) return -0.55;
    if (y === 2023) return 0.85;
    if (y === 2024) return 0.60;
    if (y === 2025) return 0.15;
    return 0.05;
  }
  return 0.07 + (rng0 - 0.5) * 0.06;
}

function simulate(ticker, isAI) {
  const t = ticker.toUpperCase();
  const rng = mulberry32(hashStr(t + (isAI ? "-ai" : "-core")));
  const base = rng();
  const start = isAI ? 20 + rng() * 120 : 40 + rng() * 120;
  const vol = isAI ? 0.42 + rng() * 0.15 : 0.15 + rng() * 0.07;
  const out = [];
  let p = start;
  const d = new Date(END);
  d.setDate(d.getDate() - Math.round(DAYS * 365 / 252));
  for (let i = 0; i < DAYS; i++) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0 || d.getDay() === 6) { i--; continue; }
    const mu = driftFor(d, isAI, base);
    const dt = 1 / 252;
    p = p * Math.exp((mu - 0.5 * vol * vol) * dt + vol * Math.sqrt(dt) * normal(rng));
    out.push({ date: new Date(d), price: p });
  }
  return out;
}

const WINDOWS = [
  { key: "1M", days: 22 }, { key: "3M", days: 64 }, { key: "6M", days: 128 },
  { key: "1Y", days: 252 }, { key: "3Y", days: 756 }, { key: "5Y", days: DAYS }, { key: "All", days: Infinity },
];

// ---------- MarketWatch CSV parsing ----------
function tickerFromName(name) {
  const m = name.match(/STOCK_US_[A-Z]+_([A-Z.]+)/i);
  return m ? m[1].toUpperCase() : name.replace(/\.csv$/i, "").toUpperCase().slice(0, 6);
}
function parseMarketWatch(text) {
  const { data } = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  const rows = data.map((r) => {
    const raw = (r.Date || r.date || "").trim();
    const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const close = parseFloat(String(r.Close ?? r.close ?? "").replace(/[",$]/g, ""));
    if (!m || !isFinite(close)) return null;
    return { date: new Date(+m[3], +m[1] - 1, +m[2]), price: close };
  }).filter(Boolean);
  rows.sort((a, b) => a.date - b.date);
  return rows;
}
function alignOnDates(a, b) {
  const keyOf = (d) => d.toISOString().slice(0, 10);
  const bMap = new Map(b.map((r) => [keyOf(r.date), r]));
  const A = [], B = [];
  for (const r of a) { const m = bMap.get(keyOf(r.date)); if (m) { A.push(r); B.push(m); } }
  return [A, B];
}

const PRESETS = {
  bubble: { window: "3Y", scale: "rebased", zero: false, emphasis: "A", label: "Bubble" },
  unstoppable: { window: "1Y", scale: "price", zero: false, emphasis: "A", label: "Unstoppable" },
  nothing: { window: "5Y", scale: "log", zero: false, emphasis: "both", label: "Nothing to see" },
  fair: { window: "5Y", scale: "rebased", zero: true, emphasis: "both", label: "Honest default" },
};

const fmtDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
const fmtLong = (d) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

// ---------- Turning points: where the chart itself asks "what happened here?" ----------
function turningPoints(series, k = 3) {
  if (series.length < 5) return [];
  const iMax = series.reduce((b, r, i) => (r.price > series[b].price ? i : b), 0);
  const iMin = series.reduce((b, r, i) => (r.price < series[b].price ? i : b), 0);
  const moves = series.slice(1).map((r, i) => ({ i: i + 1, m: r.price / series[i].price - 1 }))
    .sort((a, b) => Math.abs(b.m) - Math.abs(a.m)).slice(0, k);
  const picks = new Map();
  picks.set(iMax, "high");
  picks.set(iMin, "low");
  moves.forEach(({ i, m }) => { if (!picks.has(i)) picks.set(i, `${m >= 0 ? "+" : ""}${(m * 100).toFixed(1)}% in one day`); });
  return [...picks.entries()].sort((a, b) => a[0] - b[0])
    .map(([i, why]) => ({ date: series[i].date, price: series[i].price, why }));
}
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ---------- Claude access for the static site ----------
// Option A: set PROXY_URL to your Cloudflare Worker (see worker.js). The key stays on the server.
// Option B: leave it empty and paste a key on the page (testing only).
const PROXY_URL = window.FRAMING_LAB_PROXY_URL || "";

async function callClaude(body, apiKey) {
  const url = PROXY_URL || "https://api.anthropic.com/v1/messages";
  const headers = { "Content-Type": "application/json" };
  if (!PROXY_URL) {
    if (!apiKey) throw new Error("no-key");
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`http-${r.status}`);
  return r.json();
}

// ---------- Component ----------
export default function FramingLab() {
  const [tA, setTA] = useState("NVDA");
  const [tB, setTB] = useState("KO");
  const [aiA, setAiA] = useState(true);
  const [aiB, setAiB] = useState(false);
  const [win, setWin] = useState("1Y");
  const [scale, setScale] = useState("price");
  const [zero, setZero] = useState(false);
  const [emphasis, setEmphasis] = useState("both");
  const [headline, setHeadline] = useState("");
  const [critique, setCritique] = useState(null);
  const [critiquing, setCritiquing] = useState(false);
  const [news, setNews] = useState("");
  const [newsLoading, setNewsLoading] = useState(false);
  const [err, setErr] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [annos, setAnnos] = useState([]);       // { id, ticker, date, label, detail, source, on }
  const [annoLoading, setAnnoLoading] = useState(false);
  const [fileA, setFileA] = useState(null); // { name, rows }
  const [fileB, setFileB] = useState(null);

  async function loadCsv(file, which) {
    if (!file) return;
    try {
      const rows = parseMarketWatch(await file.text());
      if (rows.length < 5) throw new Error("short");
      const t = tickerFromName(file.name);
      if (which === "A") { setFileA({ name: file.name, rows }); applyTicker(t, "A"); }
      else { setFileB({ name: file.name, rows }); applyTicker(t, "B"); }
      setWin("All"); setCritique(null); setErr("");
    } catch (e) {
      setErr(`Could not read ${file.name}. Expected MarketWatch columns: Date, Open, High, Low, Close, Volume.`);
    }
  }
  const usingReal = !!(fileA && fileB);

  const applyTicker = (v, which) => {
    const t = v.toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 6);
    if (which === "A") { setTA(t); if (AI_TICKERS.has(t)) setAiA(true); else if (NON_AI_TICKERS.has(t)) setAiA(false); }
    else { setTB(t); if (AI_TICKERS.has(t)) setAiB(true); else if (NON_AI_TICKERS.has(t)) setAiB(false); }
  };

  const simA = useMemo(() => simulate(tA || "A", aiA), [tA, aiA]);
  const simB = useMemo(() => simulate(tB || "B", aiB), [tB, aiB]);
  const [seriesA, seriesB] = useMemo(() => {
    if (fileA && fileB) { const [a, b] = alignOnDates(fileA.rows, fileB.rows); if (a.length >= 5) return [a, b]; }
    return [simA, simB];
  }, [fileA, fileB, simA, simB]);
  const available = seriesA.length;
  const windowOk = (w) => w.key === "All" || w.days <= available;

  const view = useMemo(() => {
    const n = Math.min(WINDOWS.find((w) => w.key === win).days, seriesA.length);
    const a = seriesA.slice(-n), b = seriesB.slice(-n);
    const step = n > 300 ? Math.ceil(n / 300) : 1;
    const rows = [];
    for (let i = 0; i < a.length; i += step) {
      const va = scale === "rebased" ? (a[i].price / a[0].price) * 100 : a[i].price;
      const vb = scale === "rebased" ? (b[i].price / b[0].price) * 100 : b[i].price;
      rows.push({ d: a[i].date, label: fmtDate(a[i].date), A: +va.toFixed(2), B: +vb.toFixed(2) });
    }
    const retA = a[a.length - 1].price / a[0].price - 1;
    const retB = b[b.length - 1].price / b[0].price - 1;
    const minA = Math.min(...a.map((r) => r.price)), maxA = Math.max(...a.map((r) => r.price));
    const minB = Math.min(...b.map((r) => r.price)), maxB = Math.max(...b.map((r) => r.price));
    return { rows, retA, retB, start: a[0].date, end: a[a.length - 1].date, minA, maxA, minB, maxB };
  }, [seriesA, seriesB, win, scale]);

  const dual = scale === "price";
  const colorA = emphasis === "B" ? GREY_LINE : ORANGE;
  const colorB = emphasis === "A" ? GREY_LINE : BLUE;
  const windowKey = `${tA}|${tB}|${isoDate(view.start)}|${isoDate(view.end)}`;
  const [annoKey, setAnnoKey] = useState(windowKey);
  if (annoKey !== windowKey) { setAnnoKey(windowKey); setAnnos([]); }

  // Map annotations onto chart rows (nearest row on or after the date)
  const placed = useMemo(() => {
    const rows = view.rows;
    return annos.filter((a) => a.on).map((a, idx) => {
      const t = new Date(a.date + "T00:00:00").getTime();
      let j = rows.findIndex((r) => r.d.getTime() >= t);
      if (j < 0) j = rows.length - 1;
      const row = rows[j];
      const isA = a.ticker === tA;
      return { ...a, n: idx + 1, x: row.label, y: isA ? row.A : row.B, axis: isA ? "left" : (dual ? "right" : "left"), color: isA ? colorA : colorB };
    });
  }, [annos, view.rows, tA, dual, colorA, colorB]);

  const autoLabel = `${tA} and ${tB} closing price, ${fmtLong(view.start)} to ${fmtLong(view.end)}`;

  // The B-side: what each framing choice hides
  const hides = useMemo(() => {
    const notes = [];
    const w = WINDOWS.find((x) => x.key === win);
    const shown = view.rows.length ? Math.min(w.days, available) : 0;
    if (shown < available) notes.push(`The window starts on ${fmtDate(view.start)}. Widen it and the ranking may flip. Whoever picks the start date picks the winner.`);
    else if (usingReal) notes.push(`You are showing every day in the file (${available} trading days). MarketWatch caps downloads at one year, so anything before ${fmtDate(view.start)} is invisible, including whatever set up this trend.`);
    else notes.push(`A ${win} window shows the full cycle, but flattens the 2022 drawdown and last quarter's move into a few pixels.`);
    if (dual) notes.push(`Two y-axes. The lines cross wherever the two axis ranges happen to put them, which means nothing.`);
    if (scale === "rebased") notes.push(`Rebased to 100 at the start date. That hides price level, volatility in dollars, and how much the start date itself is doing.`);
    if (scale === "log") notes.push(`Log scale makes a 10x move look like a 2x move. Right for growth rates, misleading for anyone reading it as dollars.`);
    if (!zero && scale !== "log") {
      const lo = scale === "rebased" ? Math.min(...view.rows.map((r) => Math.min(r.A, r.B))) : null;
      notes.push(lo != null
        ? `Y-axis starts near ${lo.toFixed(0)}, not 0, so a modest move fills the whole frame.`
        : `Y-axes are trimmed to the data, so a small percentage move can look like a cliff.`);
    }
    if (emphasis !== "both") notes.push(`The grey line is still data. You decided which one the reader sees first.`);
    if (annos.some((a) => a.on)) notes.push(`Annotations explain the moves you chose to mark. They imply causation the price data cannot show, and every unmarked day still happened.`);
    return notes;
  }, [win, scale, zero, emphasis, dual, view, available, usingReal, annos]);

  // ---------- AI: critique the headline ----------
  async function runCritique() {
    setCritiquing(true); setErr(""); setCritique(null);
    const prompt = `You are coaching an MBA student on data storytelling (Minto pyramid, SCQA). They built a two-line chart and wrote a headline. Judge the headline and the framing, not the stocks.

Chart facts (${usingReal ? "real MarketWatch closing prices uploaded by the student" : "prices are simulated for teaching"}):
- Line A: ${tA} (${aiA ? "AI stock" : "non-AI stock"}), ${pct(view.retA)} over the window
- Line B: ${tB} (${aiB ? "AI stock" : "non-AI stock"}), ${pct(view.retB)} over the window
- Window: ${win}, ${fmtDate(view.start)} to ${fmtDate(view.end)}
- Scale: ${scale === "price" ? "raw price, dual y-axis" : scale === "rebased" ? "rebased to 100 at start" : "log scale"}
- Y-axis starts at zero: ${zero ? "yes" : "no"}
- Visual emphasis: ${emphasis === "both" ? "both lines equal" : emphasis === "A" ? tA + " highlighted, " + tB + " greyed" : tB + " highlighted, " + tA + " greyed"}
- Student headline: "${headline || autoLabel}"
- Annotations on the chart: ${placed.length ? placed.map((p) => `[${p.n}] ${p.ticker} ${p.date}: ${p.label}`).join("; ") : "none"}

Return ONLY a JSON object, no markdown fences, no preamble, with these keys:
"is_claim": true if the headline states a takeaway a reader could disagree with, false if it only labels the chart
"supported": true if the chart as framed actually shows what the headline says
"verdict": one plain sentence on whether the headline works, second person
"omission": one sentence naming the most important thing this framing hides that a skeptical reader would ask about
"rewrite": a better headline, under 12 words, that is a claim and is defensible given the chart
"so_what": one sentence on what decision an executive audience could make from the rewrite
Write plainly. No em dashes. No bullet points inside strings.`;
    try {
      const data = await callClaude({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }, apiKey);
      const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const clean = text.replace(/```json|```/g, "").trim();
      setCritique(JSON.parse(clean));
    } catch (e) {
      setErr(e.message === "no-key" ? "AI features need a key or a proxy. See the AI access box at the bottom." : "The critique did not come back cleanly. Try once more.");
    } finally { setCritiquing(false); }
  }

  // ---------- AI: real news via web search ----------
  async function fetchNews() {
    setNewsLoading(true); setErr(""); setNews("");
    const prompt = `Search the web for the most recent news (past few weeks) on the stocks ${tA} and ${tB}. Write a short brief for MBA students, plain text, no markdown headers, no em dashes:
${tA}: three short bullets starting with "- ", each one fact with the source name in parentheses.
${tB}: three short bullets, same format.
Then one final line starting with "Framing note:" that says whether recent news would change how a reader should interpret a ${win} price chart of these two. Keep the whole thing under 180 words.`;
    try {
      const data = await callClaude({
        model: "claude-sonnet-4-6", max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }, apiKey);
      const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      setNews(text || "No news came back. Try again.");
    } catch (e) {
      setErr(e.message === "no-key" ? "AI features need a key or a proxy. See the AI access box at the bottom." : "News search failed. Try again in a moment.");
    } finally { setNewsLoading(false); }
  }

  // ---------- AI: annotate the turning points ----------
  async function findAnnotations() {
    setAnnoLoading(true); setErr(""); setCritique(null);
    const n = Math.min(WINDOWS.find((w) => w.key === win).days, seriesA.length);
    const tpA = turningPoints(seriesA.slice(-n));
    const tpB = turningPoints(seriesB.slice(-n));
    const list = (t, tp) => tp.map((p) => `${isoDate(p.date)} (${p.why})`).join(", ");
    const prompt = `You are helping an MBA student annotate a stock price chart covering ${isoDate(view.start)} to ${isoDate(view.end)}.
The chart's own turning points are:
${tA}: ${list(tA, tpA)}
${tB}: ${list(tB, tpB)}

Search the web for what happened to each company on or within two trading days of those dates (earnings, product news, guidance, macro events, analyst moves, index moves). Also add at most two other major dated events inside the window for either ticker that a reader would expect to see marked.

Return ONLY a JSON array, no markdown fences, no preamble. Each item:
{"ticker": "${tA}" or "${tB}", "date": "YYYY-MM-DD" (the trading date nearest the event), "label": under 6 words for the chart, "detail": one plain sentence explaining the move, "source": publication name}
Skip any turning point where you find nothing specific; do not invent causes. Prefer 4 to 8 items total. No em dashes.`;
    try {
      const data = await callClaude({
        model: "claude-sonnet-4-6", max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }, apiKey);
      const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) throw new Error("parse");
      const arr = JSON.parse(m[0]).filter((a) => a && a.date && (a.ticker === tA || a.ticker === tB))
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((a, i) => ({ ...a, id: i, on: true }));
      if (!arr.length) throw new Error("empty");
      setAnnos(arr);
    } catch (e) {
      setErr(e.message === "no-key" ? "AI features need a key or a proxy. See the AI access box at the bottom." : "No dated events came back for this window. Try a longer window or run it again.");
    } finally { setAnnoLoading(false); }
  }

  const applyPreset = (k) => {
    const p = PRESETS[k];
    setWin(p.window); setScale(p.scale); setZero(p.zero); setEmphasis(p.emphasis); setCritique(null);
  };

  // ---------- UI bits ----------
  const Seg = ({ options, value, onChange }) => (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button key={o.value} onClick={() => { onChange(o.value); setCritique(null); }}
          className="px-3 py-1 text-sm rounded"
          style={{
            background: value === o.value ? BLUE : "white",
            color: value === o.value ? "white" : INK,
            border: `1px solid ${value === o.value ? BLUE : RULE}`,
          }}>{o.label}</button>
      ))}
    </div>
  );
  const Field = ({ label, children }) => (
    <div className="mb-5">
      <div className="text-sm mb-2" style={{ color: MUTED }}>{label}</div>
      {children}
    </div>
  );

  return (
    <div style={{ fontFamily: "Inter, 'Helvetica Neue', Arial, sans-serif", color: INK, background: "white", minHeight: "100vh" }}>
      <div className="max-w-6xl mx-auto px-5 py-8">
        {/* Header */}
        <div className="mb-8 pb-6" style={{ borderBottom: `2px solid ${BLUE}` }}>
          <h1 className="text-3xl font-semibold" style={{ color: BLUE, fontFamily: "Georgia, 'Times New Roman', serif" }}>
            Same data, four decisions, opposite headlines
          </h1>
          <p className="mt-2 max-w-3xl leading-relaxed" style={{ color: MUTED }}>
            Pick an AI stock and a non-AI stock. Then turn the four framing dials and watch the story change while the numbers stay the same.
            The chart is never neutral. Your job is to make the decisions on purpose and say what they hide.
          </p>
          <p className="mt-2 text-sm" style={{ color: MUTED }}>
            {usingReal
              ? `Showing real closing prices from your two MarketWatch files (${available} shared trading days).`
              : "Prices are simulated until you upload MarketWatch files for both tickers. The news panel at the bottom is always real."}
          </p>
        </div>

        <div className="grid gap-8 lab-grid">
          {/* Controls */}
          <div>
            <Field label="Two tickers">
              <div className="flex gap-2 items-center mb-2">
                <span className="w-3 h-3 rounded-full" style={{ background: ORANGE }} />
                <input value={tA} onChange={(e) => applyTicker(e.target.value, "A")} className="flex-1 px-2 py-1 rounded text-sm" style={{ border: `1px solid ${RULE}` }} />
                <button onClick={() => setAiA(!aiA)} className="text-xs px-2 py-1 rounded" style={{ border: `1px solid ${RULE}`, color: aiA ? ORANGE : MUTED }}>{aiA ? "AI" : "non-AI"}</button>
              </div>
              <div className="flex gap-2 items-center">
                <span className="w-3 h-3 rounded-full" style={{ background: BLUE }} />
                <input value={tB} onChange={(e) => applyTicker(e.target.value, "B")} className="flex-1 px-2 py-1 rounded text-sm" style={{ border: `1px solid ${RULE}` }} />
                <button onClick={() => setAiB(!aiB)} className="text-xs px-2 py-1 rounded" style={{ border: `1px solid ${RULE}`, color: aiB ? ORANGE : MUTED }}>{aiB ? "AI" : "non-AI"}</button>
              </div>
              <div className="text-xs mt-2" style={{ color: MUTED }}>{usingReal ? "The AI tag only labels the stock for the critique." : "The AI tag changes the simulated path: bigger swings, a 2022 slump, a 2023 to 2024 surge."}</div>
            </Field>

            <Field label="Upload real prices (optional)">
              {[["A", fileA, ORANGE, tA], ["B", fileB, BLUE, tB]].map(([k, f, c, t]) => (
                <label key={k} className="flex items-center gap-2 mb-2 px-2 py-2 rounded cursor-pointer text-sm"
                  style={{ border: `1px dashed ${f ? c : RULE}`, background: f ? PANEL : "white" }}>
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: c }} />
                  <span className="truncate" style={{ color: f ? INK : MUTED }}>{f ? f.name : `Choose CSV for ${t || "line " + k}`}</span>
                  <input type="file" accept=".csv,text/csv" className="hidden"
                    onChange={(e) => { loadCsv(e.target.files?.[0], k); e.target.value = ""; }} />
                </label>
              ))}
              <div className="text-xs leading-relaxed" style={{ color: MUTED }}>
                Use the MarketWatch historical download (Date, Open, High, Low, Close, Volume). Set the date range to one year before downloading.
                Example: <a href="https://www.marketwatch.com/investing/stock/ko/download-data?mod=mw_quote_tab" target="_blank" rel="noreferrer" style={{ color: BLUE, textDecoration: "underline" }}>marketwatch.com/investing/stock/ko/download-data</a>. Swap ko for any ticker.
              </div>
              {(fileA || fileB) && (
                <button onClick={() => { setFileA(null); setFileB(null); setWin("1Y"); setCritique(null); }} className="mt-2 text-xs underline" style={{ color: MUTED }}>Clear uploads and go back to simulated data</button>
              )}
            </Field>

            <Field label="Tell a story in one click">
              <div className="flex flex-wrap gap-1">
                {Object.entries(PRESETS).map(([k, p]) => (
                  <button key={k} onClick={() => applyPreset(k)} className="px-3 py-1 text-sm rounded"
                    style={{ border: `1px solid ${ORANGE}`, color: ORANGE, background: "white" }}>{p.label}</button>
                ))}
              </div>
            </Field>

            <div className="pt-4 mt-2" style={{ borderTop: `1px solid ${RULE}` }}>
              <div className="text-sm font-medium mb-4">The four dials</div>
              <Field label="1. Time window">
                <Seg value={win} onChange={setWin} options={WINDOWS.filter(windowOk).map((w) => ({ value: w.key, label: w.key }))} />
                {usingReal && <div className="text-xs mt-2" style={{ color: MUTED }}>Windows longer than the uploaded files are hidden.</div>}
              </Field>
              <Field label="2. Scale">
                <Seg value={scale} onChange={setScale} options={[
                  { value: "price", label: "Price, two axes" }, { value: "rebased", label: "Rebased to 100" }, { value: "log", label: "Log" },
                ]} />
              </Field>
              <Field label="3. Y-axis starts at zero">
                <Seg value={zero} onChange={setZero} options={[{ value: true, label: "Yes" }, { value: false, label: "No" }]} />
              </Field>
              <Field label="4. Emphasis">
                <Seg value={emphasis} onChange={setEmphasis} options={[
                  { value: "both", label: "Both" }, { value: "A", label: tA }, { value: "B", label: tB },
                ]} />
              </Field>
            </div>
          </div>

          {/* Chart + story */}
          <div>
            <div className="mb-3">
              <input
                value={headline}
                onChange={(e) => { setHeadline(e.target.value); setCritique(null); }}
                placeholder={autoLabel}
                className="w-full px-0 py-1 text-2xl outline-none"
                style={{
                  fontFamily: "Georgia, 'Times New Roman', serif", color: headline ? INK : MUTED,
                  borderBottom: `1px dashed ${RULE}`, background: "transparent",
                }}
              />
              <div className="text-xs mt-1" style={{ color: MUTED }}>
                {headline ? "Your headline. Is it a claim or a label?" : "Grey text is the label most people write. Replace it with a headline: the one thing you want the reader to take away."}
              </div>
            </div>

            <div style={{ height: 380 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={view.rows} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={RULE} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: MUTED }} minTickGap={40} axisLine={{ stroke: RULE }} tickLine={false} />
                  {dual ? (
                    <>
                      <YAxis yAxisId="left" domain={zero ? [0, "auto"] : ["auto", "auto"]} tick={{ fontSize: 11, fill: colorA }} axisLine={false} tickLine={false} width={48}
                        tickFormatter={(v) => `$${Math.round(v)}`} />
                      <YAxis yAxisId="right" orientation="right" domain={zero ? [0, "auto"] : ["auto", "auto"]} tick={{ fontSize: 11, fill: colorB }} axisLine={false} tickLine={false} width={48}
                        tickFormatter={(v) => `$${Math.round(v)}`} />
                    </>
                  ) : (
                    <YAxis yAxisId="left"
                      scale={scale === "log" ? "log" : "auto"}
                      domain={scale === "log" ? ["auto", "auto"] : zero ? [0, "auto"] : ["auto", "auto"]}
                      tick={{ fontSize: 11, fill: MUTED }} axisLine={false} tickLine={false} width={48}
                      tickFormatter={(v) => scale === "rebased" ? Math.round(v) : `$${Math.round(v)}`} />
                  )}
                  <Tooltip contentStyle={{ fontSize: 12, border: `1px solid ${RULE}`, borderRadius: 4 }}
                    formatter={(v, name) => [scale === "rebased" ? v.toFixed(0) : `$${v.toFixed(2)}`, name === "A" ? tA : tB]} />
                  {scale === "rebased" && <ReferenceLine yAxisId="left" y={100} stroke={MUTED} strokeDasharray="3 3" />}
                  <Line yAxisId="left" type="monotone" dataKey="A" stroke={colorA} strokeWidth={emphasis === "A" ? 2.6 : 1.8} dot={false} isAnimationActive={false} />
                  <Line yAxisId={dual ? "right" : "left"} type="monotone" dataKey="B" stroke={colorB} strokeWidth={emphasis === "B" ? 2.6 : 1.8} dot={false} isAnimationActive={false} />
                  {placed.map((p) => (
                    <ReferenceLine key={"l" + p.id} yAxisId="left" x={p.x} stroke={p.color} strokeDasharray="2 3" strokeOpacity={0.6} />
                  ))}
                  {placed.map((p) => (
                    <ReferenceDot key={"d" + p.id} yAxisId={p.axis} x={p.x} y={p.y} r={9} fill={p.color} stroke="white" strokeWidth={1.5}
                      label={{ value: p.n, position: "center", fill: "white", fontSize: 10, fontWeight: 700 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Stats strip */}
            <div className="flex flex-wrap gap-6 mt-2 text-sm" style={{ color: MUTED }}>
              <span><span style={{ color: colorA, fontWeight: 600 }}>{tA}</span> {pct(view.retA)} over {win}</span>
              <span><span style={{ color: colorB, fontWeight: 600 }}>{tB}</span> {pct(view.retB)} over {win}</span>
              <span>{fmtDate(view.start)} to {fmtDate(view.end)}</span>
            </div>

            {/* The story on the chart */}
            <div className="mt-6">
              <div className="flex flex-wrap items-center gap-3">
                <div className="font-medium">The story on the chart</div>
                <button onClick={findAnnotations} disabled={annoLoading} className="px-3 py-1.5 rounded text-sm"
                  style={{ border: `1px solid ${BLUE}`, color: annoLoading ? MUTED : BLUE, background: "white" }}>
                  {annoLoading ? "Finding what happened..." : annos.length ? "Search again" : "Find the turning points"}
                </button>
                <span className="text-xs" style={{ color: MUTED }}>Reads the peaks, troughs and biggest daily moves in this window, then searches the news for each date.</span>
              </div>
              {annos.length > 0 && (
                <ol className="mt-3 space-y-2 text-sm">
                  {annos.map((a) => {
                    const p = placed.find((x) => x.id === a.id);
                    const c = a.ticker === tA ? colorA : colorB;
                    return (
                      <li key={a.id} className="flex gap-3 items-start" style={{ opacity: a.on ? 1 : 0.45 }}>
                        <button onClick={() => { setAnnos(annos.map((x) => x.id === a.id ? { ...x, on: !x.on } : x)); setCritique(null); }}
                          title={a.on ? "Hide from chart" : "Show on chart"}
                          className="flex-shrink-0 rounded-full text-xs font-semibold"
                          style={{ width: 22, height: 22, background: a.on ? c : "white", color: a.on ? "white" : MUTED, border: `1.5px solid ${c}` }}>
                          {p ? p.n : ""}
                        </button>
                        <div>
                          <span className="font-medium">{a.ticker}, {new Date(a.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}: {a.label}</span>
                          <span className="leading-relaxed" style={{ color: MUTED }}> {a.detail}{a.source ? ` (${a.source})` : ""}</span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              {annos.length > 0 && <div className="text-xs mt-2" style={{ color: MUTED }}>Click a number to drop it from the chart. Which events belong in your story, and which are noise you're tempted to explain?</div>}
            </div>

            {/* What this framing hides */}
            <div className="mt-6 p-4 rounded" style={{ background: PANEL }}>
              <div className="font-medium mb-2">What this framing hides</div>
              <ul className="text-sm leading-relaxed space-y-1">
                {hides.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            </div>

            {/* Critique */}
            <div className="mt-6">
              <div className="flex items-center gap-3">
                <button onClick={runCritique} disabled={critiquing} className="px-4 py-2 rounded text-sm font-medium"
                  style={{ background: critiquing ? MUTED : ORANGE, color: "white" }}>
                  {critiquing ? "Reading your chart..." : "Critique my headline"}
                </button>
                <span className="text-xs" style={{ color: MUTED }}>Checks whether the headline is a claim, whether the framing supports it, and what a skeptic would ask.</span>
              </div>
              {critique && (
                <div className="mt-4 grid gap-3 text-sm" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                  <div className="p-4 rounded" style={{ border: `1px solid ${RULE}` }}>
                    <div className="flex gap-2 mb-2">
                      <span className="px-2 py-0.5 rounded text-xs" style={{ background: critique.is_claim ? BLUE : RULE, color: critique.is_claim ? "white" : INK }}>{critique.is_claim ? "Claim" : "Label"}</span>
                      <span className="px-2 py-0.5 rounded text-xs" style={{ background: critique.supported ? BLUE : ORANGE, color: "white" }}>{critique.supported ? "Supported" : "Not supported"}</span>
                    </div>
                    <p className="leading-relaxed">{critique.verdict}</p>
                    <p className="leading-relaxed mt-2"><span style={{ color: MUTED }}>Omission: </span>{critique.omission}</p>
                  </div>
                  <div className="p-4 rounded" style={{ background: PANEL }}>
                    <div className="text-xs mb-1" style={{ color: MUTED }}>Try this headline</div>
                    <p className="text-lg leading-snug" style={{ fontFamily: "Georgia, serif" }}>{critique.rewrite}</p>
                    <p className="text-sm mt-3 leading-relaxed"><span style={{ color: MUTED }}>So what: </span>{critique.so_what}</p>
                    <button onClick={() => setHeadline(critique.rewrite)} className="mt-3 text-xs underline" style={{ color: BLUE }}>Use it</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* News */}
        <div className="mt-10 pt-6" style={{ borderTop: `1px solid ${RULE}` }}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="font-medium">What actually happened to {tA} and {tB}</div>
            <button onClick={fetchNews} disabled={newsLoading} className="px-3 py-1.5 rounded text-sm"
              style={{ border: `1px solid ${BLUE}`, color: newsLoading ? MUTED : BLUE, background: "white" }}>
              {newsLoading ? "Searching..." : "Search recent news"}
            </button>
            <span className="text-xs" style={{ color: MUTED }}>Live web search. Use it to ask whether the chart above, framed the way it is, would survive contact with the news.</span>
          </div>
          {news && (
            <pre className="mt-4 p-4 rounded text-sm leading-relaxed whitespace-pre-wrap" style={{ background: PANEL, fontFamily: "inherit" }}>{news}</pre>
          )}
        </div>

        {err && <div className="mt-4 text-sm" style={{ color: ORANGE }}>{err}</div>}

        {!PROXY_URL && (
          <div className="mt-8 p-4 rounded text-sm" style={{ border: `1px solid ${RULE}` }}>
            <div className="font-medium mb-1">AI access</div>
            <div className="text-xs mb-2 leading-relaxed" style={{ color: MUTED }}>
              This page is running without a proxy, so the critique and news buttons need an Anthropic API key. It stays in this tab and is never saved.
              For a class link, set up the worker instead so students never handle a key.
            </div>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-..."
              className="w-full px-2 py-1 rounded text-sm" style={{ border: `1px solid ${RULE}` }} />
          </div>
        )}

        <div className="mt-10 text-xs leading-relaxed" style={{ color: MUTED }}>
          Built for the MBA data visualization course, Gies College of Business. The framing exercise mirrors the e-scooter case: a press release reports the first-order effect, the analyst's job is the part it leaves out.
        </div>
      </div>
    </div>
  );
}
