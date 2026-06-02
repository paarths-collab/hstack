---
name: hermes-install
description: Install Hermes Agent reliably (local or over SSH), pinned to a known-good version and PATH-safe. Use when Hermes needs to be installed on a machine or VPS.
---

# /hermes-install — install Hermes (pinned, PATH-safe, no sudo)

## Target
- **Local / WSL2 / VPS shell:** run directly.
- **Remote VPS:** SSH in first (`ssh user@host`). For Hostinger one-click Docker, Hermes is already
  containerized — skip to configuration.

## Procedure
```bash
# 1. Prerequisites (curl needed). NEVER use sudo for the installer itself.
command -v curl >/dev/null || sudo apt-get update && sudo apt-get install -y curl ca-certificates

# 2. Install — the OFFICIAL installer. --skip-setup keeps it non-interactive (we wire the
#    provider + keys in /hermes-model via `hermes config set`); --skip-browser avoids the
#    Chromium-deps failure on headless VPS. Gets the current stable build.
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup --skip-browser

# 3. Make hermes resolvable in THIS shell (rc file is not reloaded automatically).
export PATH="$HOME/.local/bin:$PATH"
HERMES="$HOME/.local/bin/hermes"      # use this absolute path for all later steps

# 4. Verify
test -x "$HERMES" && "$HERMES" --version || { echo "FAIL: hermes not installed"; exit 1; }
"$HERMES" doctor 2>&1 | tee /tmp/hermes_doctor.log    # capture; do NOT gate on its exit code
```

- **Windows (native, PowerShell):** `irm https://hermes-agent.nousresearch.com/install.ps1 | iex`
- **Attended / manual install:** run `hermes setup` (the interactive wizard for provider, model, and keys) instead of leaving it to /hermes-model.
- **Pin a version** for reproducibility: `pip install "hermes-agent==0.15.2"` (current stable; GitHub tag `v2026.5.29.2` == PyPI `0.15.2` are the same build), or pass `--commit <SHA>` to install.sh. Then upgrade deliberately with /hermes-update.

## Pitfalls (pre-solve these)
- **"hermes: command not found" after a successful install** — the #1 churn point. The rc-file PATH
  edit didn't reach the live shell. Fix: `export PATH` as above and use the absolute `$HERMES` path;
  tell the user to `source ~/.bashrc` or restart the terminal.
- **`--skip-browser`** avoids the Chromium-deps failure (the #1 headless install failure).
- **Never `sudo` the installer** — it creates root-owned files the gateway can't read later. If a prior
  sudo install exists: `sudo rm /usr/local/bin/hermes` then reinstall.
- **Docker UID:** pin a tagged image (avoid `v2026.4.23`; avoid `main`/`latest` on UID-99 NAS hosts);
  honor `HERMES_UID`/`HERMES_GID`; run CLI + gateway as the same UID.
- **Windows:** installs natively via PowerShell (`irm https://hermes-agent.nousresearch.com/install.ps1 | iex`); WSL2 optional. For an always-on agent, prefer a Linux VPS regardless.

## Verify
`hermes --version` exits 0; toolchain present (`node --version`, `python3 --version`, `git --version`).
