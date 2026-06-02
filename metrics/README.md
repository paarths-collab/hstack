# Metrics — install tracking, the on-brand way

The hstack install **is a `git clone`**, so GitHub already counts every install for you — no
code in the toolkit, no service, no user telemetry. The single headline number is:

> **Unique cloners over time** = essentially "how many people ran the install command."

You can see it live at **Repo → Insights → Traffic → "Git clones"**. The catch: GitHub only keeps
**14 days**. This folder keeps the **full history**.

## How it works

[`.github/workflows/clone-traffic.yml`](../.github/workflows/clone-traffic.yml) runs once a day,
calls `GET /repos/paarths-collab/hstack/traffic/clones`, and merges the result into
[`clone-traffic.json`](clone-traffic.json) (days are keyed by date, so the 14-day overlap dedupes).
It commits the file back to the repo, so history accrues forever.

`clone-traffic.json` ends up looking like:

```json
{
  "totals": { "days": 42, "clones": 318, "unique_cloners_approx": 207 },
  "days": { "2026-06-01": { "count": 9, "uniques": 6 }, "2026-06-02": { "count": 5, "uniques": 4 } }
}
```

- **`unique_cloners_approx`** sums each day's unique cloners. It's the right headline proxy, with one
  honest caveat: someone who clones on two *different* days counts twice (GitHub only de-dupes within
  a single 14-day window, not across all time).

## One-time setup (required)

The traffic API needs **push/admin** access — the default `GITHUB_TOKEN` returns `403`, so add a token:

1. Create a token that can read traffic:
   - **Fine-grained PAT** (recommended): scope it to `paarths-collab/hstack`, permission **Administration → Read-only**. Or
   - **Classic PAT**: `repo` scope.
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `TRAFFIC_TOKEN`  ·  Value: the token.
3. Trigger it once: **Actions → Clone traffic → Run workflow** (then it runs daily on its own).

## Run it locally instead (optional)

No Actions needed — run the same script by hand or from your own cron/Task Scheduler:

```bash
TRAFFIC_TOKEN=ghp_xxx REPO=paarths-collab/hstack node metrics/update-clone-traffic.mjs
```

## What this is *not*

It does **not** track who installed, where, or anything about the agents people deploy. It is only
GitHub's own aggregate clone count — the most privacy-respecting install metric available, which fits
hstack's "your agent, your server, no middleman" stance.
