---
name: hermes-install
description: Install Hermes Agent reliably over SSH on a VPS (or locally) — pinned to a known-good version, PATH-safe, idempotent, and runnable by any AI agent. Use when Hermes needs to be installed on a machine or VPS.
---

# /hermes-install — install Hermes (SSH-first, pinned, PATH-safe, no sudo)

You are the engineer installing Hermes for the user. The agent running this skill
(Hermes itself, Claude Code, Codex, Cursor, Gemini CLI — any of them) usually talks
to a remote VPS over SSH as root. Every command in this skill is written to run on
the VPS. If the user is installing locally, swap the `ssh "$VPS_USER@$VPS_IP" ...`
wrappers for direct execution — the body of each command is identical.

Do everything autonomously; stop only for things a machine cannot do (mint a
provider key, accept a vendor TOS in a browser).

**Honest install picture (verified 2026-06):** the official installer at
`scripts/install.sh` from `NousResearch/hermes-agent` is the source of truth. Pin
`hermes-agent==0.15.2` (GitHub tag `v2026.5.29.2` is the same build) for
reproducibility. The installer edits `~/.bashrc` to add `~/.local/bin` to PATH,
but the edit does NOT reach the live shell — every later step must use the
absolute path `$HOME/.local/bin/hermes`. For Hostinger one-click Docker, Hermes
is already containerized and this skill exits at Step 2.

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS to install on (omit for local) | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` (omit for local) | Their hosting dashboard |
| `$HERMES_VERSION` | Pinned version, default `0.15.2` | Optional — leave default unless upgrading |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — confirm host vs container (the #1 source of churn)

SSH keys added inside a container are invisible to the host's sshd, and a
Hermes install inside a container disappears when the container is recreated.
Always check before installing.

```bash
ssh "$VPS_USER@$VPS_IP" '
  WHO=$(whoami)
  HOST=$(hostname)
  echo "user=$WHO host=$HOST"
  case "$HOST" in
    *[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
      echo "WARN: hostname looks like a container hex id. exit the container first." >&2 ;;
  esac
'
```

If the hostname is a readable VPS name (e.g. `root@digitalcrew-vps-1`), proceed.
If it is a hex string (e.g. `root@dd635306c545`), abort — the user is inside a
Docker container and must `exit` first.

---

## Step 2 — idempotency check (skip if already installed and healthy)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" '
  if [ -x "$HOME/.local/bin/hermes" ]; then
    "$HOME/.local/bin/hermes" --version 2>/dev/null | grep -c "^"
  elif command -v hermes >/dev/null 2>&1; then
    hermes --version 2>/dev/null | grep -c "^"
  elif docker ps --format "{{.Names}}" 2>/dev/null | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version 2>/dev/null | grep -c "^"
  else
    echo 0
  fi
' || echo 0)

if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Hermes is already installed. Re-run with FORCE=1 to reinstall."
  exit 0
fi
```

If a containerized Hostinger build is detected, exit 0 — Hermes is already
managed by the image and reinstalling it would break the supervisor.

---

## Step 3 — DRY RUN preview (always show before installing)

```bash
cat <<EOF
DRY RUN — the following will happen on ${VPS_USER:-local}@${VPS_IP:-localhost}:
  1. Ensure curl + ca-certificates (apt-get install if missing). NEVER sudo the installer itself.
  2. Run official installer:
       curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \\
         | bash -s -- --skip-setup --skip-browser
  3. Export PATH=\$HOME/.local/bin:\$PATH for THIS shell (rc reload does not happen automatically).
  4. Pin version: pip install "hermes-agent==${HERMES_VERSION:-0.15.2}"
  5. Run hermes --version and capture hermes doctor to /tmp/hermes_doctor.log
  6. NOT touched: ~/.hermes/.env, ~/.hermes/config.yaml (provider keys come via /hermes-model).

The installer is NEVER run with sudo (it would create root-owned files the gateway can't read).
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — install prerequisites (curl, ca-certificates) without breaking idempotency

```bash
ssh "$VPS_USER@$VPS_IP" '
  if ! command -v curl >/dev/null 2>&1; then
    apt-get update && apt-get install -y curl ca-certificates
  fi
'
```

`apt-get` may need `sudo` on a non-root user, but on a typical VPS `$VPS_USER=root`
so it runs directly. Never `sudo` the installer itself in Step 5.

---

## Step 5 — run the official installer (non-interactive, headless-safe)

`--skip-setup` keeps the install non-interactive (provider, model, and keys
are wired later by `/hermes-model` via `hermes config set`).
`--skip-browser` avoids the Chromium-deps failure on a headless VPS (the #1
headless install failure).

```bash
ssh "$VPS_USER@$VPS_IP" '
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
    | bash -s -- --skip-setup --skip-browser
'
```

Failure detection:

```bash
ssh "$VPS_USER@$VPS_IP" 'test -x "$HOME/.local/bin/hermes"' \
  || { echo "FAIL: installer ran but hermes binary not present. Rolling back."; rollback; exit 1; }
```

> **Windows (native, PowerShell)** — if the target is a Windows machine, run
> instead: `iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)`.
> For an always-on agent, prefer a Linux VPS regardless.

> **Attended / manual install** — `hermes setup` runs the interactive wizard for
> provider, model, and keys. Use it instead of leaving wiring to `/hermes-model`
> when a human is at the keyboard.

---

## Step 6 — make hermes resolvable and pin the version

The rc-file PATH edit does NOT reach the live shell. Every later step in this
skill (and in every other hstack skill) uses the absolute path
`$HOME/.local/bin/hermes`.

```bash
ssh "$VPS_USER@$VPS_IP" '
  export PATH="$HOME/.local/bin:$PATH"
  HERMES="$HOME/.local/bin/hermes"
  test -x "$HERMES" || { echo "FAIL: $HERMES not executable"; exit 1; }

  # Pin to a known-good build. GitHub tag v2026.5.29.2 == PyPI 0.15.2.
  pip install --quiet "hermes-agent=='"${HERMES_VERSION:-0.15.2}"'" 2>/dev/null || \
    pip install --quiet --user "hermes-agent=='"${HERMES_VERSION:-0.15.2}"'"
'
```

The `pip install` may fail harmlessly if the installer already pinned the same
version — that is fine and the next step verifies the result.

---

## Step 7 — verify install (hard gate)

```bash
VER=$(ssh "$VPS_USER@$VPS_IP" '"$HOME/.local/bin/hermes" --version 2>/dev/null' || echo "")
case "$VER" in
  *0.15.*|*0.17.*)
    echo "OK: Hermes $VER installed." ;;
  "")
    echo "FAIL: hermes --version returned nothing. Rolling back."
    rollback
    exit 1 ;;
  *)
    echo "WARN: Hermes version is $VER — expected 0.15.x or 0.17.x. Continuing."
    ;;
esac
```

Capture `hermes doctor` for the troubleshooting trail — but do NOT gate on its
exit code; doctor warns about optional components that are normal to be missing
right after install.

```bash
ssh "$VPS_USER@$VPS_IP" '"$HOME/.local/bin/hermes" doctor 2>&1 | tee /tmp/hermes_doctor.log' \
  || echo "WARN: hermes doctor returned non-zero — see /tmp/hermes_doctor.log on the VPS."
```

---

## Step 8 — verify the surrounding toolchain (best-effort)

Hermes itself works without these, but the common skills downstream
(`/hermes-skills`, `/hermes-memory`) expect node and python.

```bash
ssh "$VPS_USER@$VPS_IP" '
  for cmd in node python3 git; do
    if command -v "$cmd" >/dev/null 2>&1; then
      printf "%-8s %s\n" "$cmd" "$($cmd --version 2>&1 | head -1)"
    else
      printf "%-8s MISSING (install before /hermes-skills)\n" "$cmd"
    fi
  done
'
```

Missing tools are a warning, not a failure — `/hermes-skills` will install what
it needs when it runs.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" '
    pip uninstall -y hermes-agent 2>/dev/null || true
    rm -f "$HOME/.local/bin/hermes" 2>/dev/null || true
    # Do NOT touch ~/.hermes — user secrets and config may live there from a prior install.
  '
  echo "Rolled back. Hermes binary removed; ~/.hermes preserved."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `hermes: command not found` after successful install | The rc-file PATH edit doesn't reach the live shell | Use absolute `$HOME/.local/bin/hermes`; tell the user to `source ~/.bashrc` or restart the terminal |
| 2 | Installing inside a Docker container by mistake | Install vanishes when container is recreated; SSH keys invisible to host sshd | Step 1 hostname check; abort on hex hostname |
| 3 | `sudo curl ... | bash` for the installer | Creates root-owned files the gateway can't read later | NEVER sudo the installer; `sudo rm /usr/local/bin/hermes` if a prior sudo install exists, then reinstall |
| 4 | Chromium-deps failure on headless VPS | Default install pulls a browser stack | Always pass `--skip-browser` |
| 5 | Interactive wizard hangs in non-TTY agent shell | Default `install.sh` runs `hermes setup` after install | Always pass `--skip-setup`; wire provider via `/hermes-model` |
| 6 | Docker UID mismatch on NAS hosts | Tags like `v2026.4.23`, `main`, `latest` ship with the wrong UID | Pin a tagged image; honor `HERMES_UID`/`HERMES_GID`; run CLI + gateway as the same UID |
| 7 | `echo >>` into `~/.bashrc` to fix PATH | Can merge onto a prior line without trailing newline (same failure class as `authorized_keys`) | Use `printf '\n%s\n'` if you ever edit rc files; better, just use the absolute path |
| 8 | `gateway restart` after install to "pick up" env | Restart does NOT reliably re-read `.env` — but `/hermes-install` does not run the gateway anyway | The gateway is started by downstream skills (`/hermes-skills`, `/hermes-home`); always `stop` + `run`, never `restart`, in those skills |
| 9 | Putting provider keys in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `hermes config set` (this skill does NOT write secrets) |
| 10 | sed with `/` delimiter on tokens later | Tokens contain `/+=`; sed breaks | Use `|` delimiter when editing tokens in downstream skills |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working (or running locally)
- [ ] Host vs container check passed (hostname is not a hex container id)
- [ ] Idempotency check ran (skipped if already installed, or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Installer ran NON-interactively with `--skip-setup --skip-browser`, NOT under sudo
- [ ] `$HOME/.local/bin/hermes` exists and is executable
- [ ] `hermes --version` reports `0.15.x` or `0.17.x` (pinned to `${HERMES_VERSION:-0.15.2}`)
- [ ] `hermes doctor` captured to `/tmp/hermes_doctor.log` (not gated on exit code)
- [ ] Toolchain probe shown (node/python3/git versions or MISSING markers)
- [ ] No secrets written by this skill (provider keys come via `/hermes-model`)
- [ ] Rollback function defined: removes binary, preserves `~/.hermes`

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for install and PATH failure modes.
