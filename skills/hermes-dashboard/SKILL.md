---
name: hermes-dashboard
description: Turn on the Hermes monitoring dashboard SAFELY (localhost-bound, behind an SSH tunnel or an authenticated HTTPS proxy). Use when the user wants a visual dashboard. Does not build a frontend.
---

# /hermes-dashboard — enable the dashboard, safely

Hermes ships its own dashboard on **port 9119** with a full read-only JSON API. This skill enables it
**securely** — it does NOT build a custom frontend (that's a separate task). See
`reference/api-endpoints.md` for the API a frontend would consume.

## ⚠ The load-bearing security fact
The upstream dashboard has **NO authentication of its own** — its only protection is binding to
`127.0.0.1`, and it reads/writes the `.env` containing every key. The ecosystem's default failure mode
left 175k+ agent servers exposed. So:
- **Never bind `0.0.0.0` / expose to the internet without your own auth + HTTPS.**
- Prefer an **SSH tunnel** (nothing public). If remote access is required, front it with **Caddy/Traefik
  (HTTPS + password)** and pin Starlette ≥1.0.1 (BadHost CVE-2026-48710).
- Keep `HERMES_DASHBOARD_TUI` OFF (the embedded terminal is effectively RCE).

## Enable (Docker)
```bash
docker run -d --name hermes --restart unless-stopped \
  -v ~/.hermes:/opt/data -p 8642:8642 -p 9119:9119 \
  -e HERMES_DASHBOARD=1 \
  nousresearch/hermes-agent:latest gateway run
```
## Enable (native)
```bash
hermes dashboard --port 9119 --host 127.0.0.1     # loopback only
```

## Access (the safe way)
```bash
# On the user's laptop — tunnel, then open http://127.0.0.1:9119
ssh -L 9119:127.0.0.1:9119 user@vps
```

## Version note
v0.15.0's dashboard had a 401 reload loop in loopback (localhost) mode — the exact mode hstack uses.
It was hotfixed in v0.15.1 and v0.15.2 added a packaging fix, so pin **v0.15.2** (hstack's default)
for a working dashboard.

## Verify
`curl -fsS http://127.0.0.1:9119/api/status` returns JSON; `curl http://localhost:8642/health` → `{"status":"ok"}`.
