// Fetch GitHub clone traffic and append it to clone-traffic.json, keeping full
// history past GitHub's 14-day window. Run daily by .github/workflows/clone-traffic.yml.
// Zero dependencies (Node 18+ global fetch). No user telemetry — this counts
// repo clones, which is essentially "how many people ran the install command".
//
// Env:
//   TRAFFIC_TOKEN  a token with repo Administration:Read (fine-grained PAT) or
//                  classic PAT with `repo` scope. The default GITHUB_TOKEN does
//                  NOT work for the traffic API (returns 403).
//   REPO           owner/name (defaults to GITHUB_REPOSITORY or paarths-collab/hstack)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo  = process.env.REPO || process.env.GITHUB_REPOSITORY || "paarths-collab/hstack";
const token = process.env.TRAFFIC_TOKEN;
const file  = fileURLToPath(new URL("./clone-traffic.json", import.meta.url));
const svgFile = fileURLToPath(new URL("./clone-traffic.svg", import.meta.url));

// Load existing history (or empty scaffold)
const hist = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
hist.repo  = repo;
hist.days  = hist.days  || {};
hist.note  = hist.note  || "Daily GitHub clone traffic, persisted past GitHub's 14-day window.";

// ── Fetch from GitHub API (skip gracefully if no token) ───────────────────────
if (!token) {
  console.warn("WARN: TRAFFIC_TOKEN not set — skipping API fetch, regenerating SVG from existing data.");
} else {
  const res = await fetch(`https://api.github.com/repos/${repo}/traffic/clones`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "hstack-metrics" },
  });
  if (!res.ok) { console.error(`ERROR: traffic API ${res.status} — ${await res.text()}`); process.exit(1); }
  const data = await res.json(); // { count, uniques, clones: [{ timestamp, count, uniques }] }

  // Merge: each API day is authoritative; 14-day overlap dedupes automatically.
  for (const d of data.clones || []) hist.days[d.timestamp.slice(0, 10)] = { count: d.count, uniques: d.uniques };
}

const dates = Object.keys(hist.days).sort();
const ordered = {};
for (const k of dates) ordered[k] = hist.days[k];
hist.days = ordered;
hist.totals = {
  days: dates.length,
  clones: dates.reduce((s, k) => s + hist.days[k].count, 0),
  // sum of per-day unique cloners — a person who clones on two days counts twice.
  unique_cloners_approx: dates.reduce((s, k) => s + hist.days[k].uniques, 0),
};
hist.updated = new Date().toISOString();

writeFileSync(file, JSON.stringify(hist, null, 2) + "\n");
console.log(`Tracked ${hist.totals.days} days · ${hist.totals.clones} clones · ~${hist.totals.unique_cloners_approx} unique cloners`);

// ── Generate SVG chart (star-history style — cumulative line) ─────────────────
const entries = Object.entries(hist.days); // [[date, {count, uniques}], ...]

// Build cumulative series (skip leading zeros for a cleaner chart)
let cumulative = 0;
const points = [];
for (const [date, v] of entries) {
  cumulative += v.uniques;
  if (cumulative > 0 || points.length > 0) points.push({ date, cum: cumulative });
}
// If no data yet, keep one zero point so placeholder still renders
if (points.length === 0) points.push({ date: new Date().toISOString().slice(0, 10), cum: 0 });

const W = 800, H = 400;
const PAD = { top: 60, right: 40, bottom: 70, left: 72 };
const chartW = W - PAD.left - PAD.right;
const chartH = H - PAD.top - PAD.bottom;

const LINE   = "#e05c3a";   // star-history orange-red
const AXIS   = "#1a1a1a";
const GRID   = "#e8e8e8";
const LABEL  = "#666666";
const LEGEND_BG = "#ffffff";

const maxCum = Math.max(...points.map(p => p.cum), 1);

// Nice Y-axis ceiling
function niceMax(v) {
  if (v <= 10) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag) * mag;
}
const yMax = niceMax(maxCum);

// Format Y labels: 1000 → 1K
function fmtY(v) {
  if (v >= 1000) return (v / 1000) + "K";
  return String(v);
}

const xScale = (i) => PAD.left + (i / Math.max(points.length - 1, 1)) * chartW;
const yScale = (v) => PAD.top + chartH - (v / yMax) * chartH;

// Y gridlines + labels (5 ticks)
const TICKS = 5;
let gridLines = "";
for (let t = 0; t <= TICKS; t++) {
  const val = Math.round((yMax / TICKS) * t);
  const y = Math.round(yScale(val));
  gridLines += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`;
  gridLines += `<text x="${PAD.left - 10}" y="${y + 4}" text-anchor="end" font-family="system-ui,sans-serif" font-size="12" fill="${LABEL}">${fmtY(val)}</text>`;
}

// X-axis date labels — show ~6 evenly spaced
const xEvery = Math.max(1, Math.ceil(points.length / 6));
let xLabels = "";
points.forEach(({ date }, i) => {
  if (i % xEvery !== 0 && i !== points.length - 1) return;
  const x = Math.round(xScale(i));
  xLabels += `<text x="${x}" y="${PAD.top + chartH + 22}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${LABEL}">${date.slice(0, 7)}</text>`;
});

// The cumulative line path — polyline needs 2+ points; for 1 point use a circle dot
const linePts = points.map(({ cum }, i) => `${Math.round(xScale(i))},${Math.round(yScale(cum))}`).join(" ");
const lineElement = points.length < 2
  ? `<circle cx="${Math.round(xScale(0))}" cy="${Math.round(yScale(points[0].cum))}" r="5" fill="${LINE}"/>`
  : `<polyline points="${linePts}" fill="none" stroke="${LINE}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    points.map(({ cum }, i) => `<circle cx="${Math.round(xScale(i))}" cy="${Math.round(yScale(cum))}" r="3" fill="${LINE}"/>`).join("");

// Legend box (top-left, like star-history)
const legendX = PAD.left + 12, legendY = PAD.top + 12;
const legendLabel = `paarths-collab/hstack`;
const legendW = legendLabel.length * 7.2 + 32;
const legend = `
  <rect x="${legendX}" y="${legendY}" width="${legendW}" height="28" rx="4" fill="${LEGEND_BG}" stroke="#cccccc" stroke-width="1"/>
  <circle cx="${legendX + 14}" cy="${legendY + 14}" r="5" fill="${LINE}"/>
  <text x="${legendX + 24}" y="${legendY + 19}" font-family="system-ui,sans-serif" font-size="12" fill="${AXIS}">${legendLabel}</text>`;

// Watermark bottom-right
const watermark = `<text x="${W - PAD.right}" y="${H - 10}" text-anchor="end" font-family="system-ui,sans-serif" font-size="11" fill="#aaaaaa">hstack clone history</text>`;

// Y-axis rotated label
const yAxisLabel = `<text x="${-(PAD.top + chartH / 2)}" y="18" transform="rotate(-90)" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${LABEL}">Cumulative Cloners</text>`;

// X-axis label
const xAxisLabel = `<text x="${PAD.left + chartW / 2}" y="${H - 8}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${LABEL}">Date</text>`;

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  ${gridLines}
  ${lineElement}
  ${xLabels}
  ${yAxisLabel}
  ${xAxisLabel}
  <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}" stroke="${AXIS}" stroke-width="1.5"/>
  <line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}" stroke="${AXIS}" stroke-width="1.5"/>
  ${legend}
  ${watermark}
</svg>`;

writeFileSync(svgFile, svgContent + "\n");
console.log(`SVG chart written → metrics/clone-traffic.svg`);
