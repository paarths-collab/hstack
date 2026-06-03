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

// ── Generate SVG chart ────────────────────────────────────────────────────────
const entries = Object.entries(hist.days); // [[date, {count, uniques}], ...]

const W = 800, H = 260;
const PAD = { top: 32, right: 24, bottom: 52, left: 44 };
const chartW = W - PAD.left - PAD.right;
const chartH = H - PAD.top - PAD.bottom;
const BLUE  = "#3b82f6";
const TEAL  = "#14b8a6";
const GRID  = "#e5e7eb";
const LABEL = "#6b7280";
const TITLE = "#111827";

let svgContent;

if (entries.length === 0) {
  // Placeholder — no data collected yet
  svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" rx="8" fill="#fafafa" stroke="${GRID}" stroke-width="1"/>
  <text x="${W/2}" y="${H/2 - 10}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="14" fill="${LABEL}">No clone data yet — workflow runs daily at 06:17 UTC.</text>
  <text x="${W/2}" y="${H/2 + 14}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${LABEL}">See metrics/README.md for one-time setup (add TRAFFIC_TOKEN secret).</text>
</svg>`;
} else {
  const maxCount = Math.max(...entries.map(([, v]) => v.count), 1);
  const yMax = Math.ceil(maxCount / 5) * 5 || 5;
  const slotW = chartW / entries.length;
  const barW  = Math.max(4, Math.floor(slotW * 0.6));

  const xScale = (i) => PAD.left + i * slotW + (slotW - barW) / 2;
  const yScale = (v) => PAD.top + chartH - Math.round((v / yMax) * chartH);

  // Y gridlines + labels
  const TICKS = 4;
  let gridLines = "";
  for (let t = 0; t <= TICKS; t++) {
    const val = Math.round((yMax / TICKS) * t);
    const y = yScale(val);
    gridLines += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`;
    gridLines += `<text x="${PAD.left - 6}" y="${y + 4}" text-anchor="end" font-family="system-ui,sans-serif" font-size="11" fill="${LABEL}">${val}</text>`;
  }

  // Bars (total clones) with tooltip titles
  let bars = "";
  entries.forEach(([date, v], i) => {
    const x = xScale(i);
    const y = yScale(v.count);
    const h = chartH - (y - PAD.top);
    bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2" fill="${BLUE}" opacity="0.85"><title>${date}: ${v.count} clones, ${v.uniques} unique</title></rect>`;
  });

  // Unique cloners line + dots
  const linePoints = entries.map(([, v], i) => `${xScale(i) + barW / 2},${yScale(v.uniques)}`).join(" ");
  const dots = entries.map(([date, v], i) =>
    `<circle cx="${xScale(i) + barW / 2}" cy="${yScale(v.uniques)}" r="3" fill="${TEAL}"><title>${date}: ${v.uniques} unique</title></circle>`
  ).join("");

  // X-axis date labels — show every Nth to avoid overlap
  const every = Math.max(1, Math.ceil(entries.length / 10));
  let xLabels = "";
  entries.forEach(([date], i) => {
    if (i % every !== 0 && i !== entries.length - 1) return;
    const x = xScale(i) + barW / 2;
    xLabels += `<text x="${x}" y="${PAD.top + chartH + 18}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="${LABEL}">${date.slice(5)}</text>`;
  });

  // Legend
  const legendItems = [
    { color: BLUE, shape: "rect", label: `Clones  (total: ${hist.totals.clones})` },
    { color: TEAL, shape: "line", label: `Unique cloners  (~${hist.totals.unique_cloners_approx})` },
  ];
  const legend = legendItems.map(({ color, shape, label }, i) => {
    const lx = PAD.left + i * 230;
    const ly = H - 14;
    const icon = shape === "rect"
      ? `<rect x="${lx}" y="${ly}" width="10" height="10" rx="2" fill="${color}"/>`
      : `<line x1="${lx}" y1="${ly + 5}" x2="${lx + 10}" y2="${ly + 5}" stroke="${color}" stroke-width="2"/><circle cx="${lx + 5}" cy="${ly + 5}" r="3" fill="${color}"/>`;
    return icon + `<text x="${lx + 14}" y="${ly + 9}" font-family="system-ui,sans-serif" font-size="11" fill="${LABEL}">${label}</text>`;
  }).join("");

  svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" rx="8" fill="#fff"/>
  <text x="${PAD.left}" y="20" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="${TITLE}">Git clone traffic — paarths-collab/hstack</text>
  ${gridLines}
  ${bars}
  <polyline points="${linePoints}" fill="none" stroke="${TEAL}" stroke-width="2" stroke-linejoin="round"/>
  ${dots}
  ${xLabels}
  ${legend}
  <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}" stroke="${GRID}" stroke-width="1"/>
  <line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}" stroke="${GRID}" stroke-width="1"/>
</svg>`;
}

writeFileSync(svgFile, svgContent + "\n");
console.log(`SVG chart written → metrics/clone-traffic.svg`);
