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

const repo = process.env.REPO || process.env.GITHUB_REPOSITORY || "paarths-collab/hstack";
const token = process.env.TRAFFIC_TOKEN;
const file = fileURLToPath(new URL("./clone-traffic.json", import.meta.url));

if (!token) { console.error("ERROR: set TRAFFIC_TOKEN (PAT with Administration:Read). GITHUB_TOKEN cannot read traffic."); process.exit(1); }

const res = await fetch(`https://api.github.com/repos/${repo}/traffic/clones`, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "hstack-metrics" },
});
if (!res.ok) { console.error(`ERROR: traffic API ${res.status} — ${await res.text()}`); process.exit(1); }
const data = await res.json(); // { count, uniques, clones: [{ timestamp, count, uniques }] }

const hist = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
hist.repo = repo;
hist.days = hist.days || {};
hist.note = hist.note || "Daily GitHub clone traffic, persisted past GitHub's 14-day window.";

// Merge: each API day (keyed by date) is authoritative; the 14-day overlap dedupes.
for (const d of data.clones || []) hist.days[d.timestamp.slice(0, 10)] = { count: d.count, uniques: d.uniques };

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
