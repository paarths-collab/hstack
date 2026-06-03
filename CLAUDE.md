# hstack — Claude Code instructions

This repo is **hstack**: a set of Claude Code skills for deploying and operating self-hosted
Hermes agents. Built by Paarth, in collaboration with Digital Crew Technology.

---

## Repo layout

```
skills/<name>/SKILL.md   — one skill per folder; frontmatter + procedure + pitfalls + verify
reference/TROUBLESHOOTING.md — symptom → cause → fix catalogue (grows with every deploy)
blog/                    — published guides (.md + .schema.json for JSON-LD)
metrics/                 — clone traffic tracking (update-clone-traffic.mjs + clone-traffic.svg)
.github/workflows/       — clone-traffic.yml (daily), shellcheck, secret-scan
```

## Skill format (always follow this when adding or editing a skill)

```markdown
---
name: hermes-<verb>
description: One sentence. When to use it.
---

# /<name> — short title

You are the engineer doing X for the user. Do everything autonomously; stop only for
things a machine cannot do (tokens, QR scans, first "hello").

## Before you start — gather (ask once)
## Step 1 …
## Step N …
## Definition of done
- [ ] …
```

Secrets always go in `~/.hermes/.env` or `/opt/data/.env` (inside container), never in
`config.yaml` and never in chat. Use `chmod 600` after writing.

---

## SSH access to a VPS — the right procedure

When a user hands off a VPS for remote work, follow this exact sequence.
Deviating from it causes the failure chain documented in `reference/TROUBLESHOOTING.md`.

### Before touching anything — confirm you're on the host, not a container

```bash
whoami; hostname
```

- `root@<readable-name>` → you are on the **VPS host** ✅
- `root@<hex-string>` (e.g. `root@dd635306c545`) → you are **inside a Docker container** ❌
  Type `exit` first, then re-run the check.

SSH keys added inside a container are invisible to the host's sshd. This is the #1 source
of "I added the key but still get Permission denied."

### Setting up key-based auth (Bash tool is non-interactive — can't type passwords)

```bash
# 1. Generate keypair
ssh-keygen -t ed25519 -f ~/.ssh/hermes_vps -N "" -C "claude-code-hermes-deploy"

# 2. Add public key on the VPS host — ALWAYS use printf, never echo >>
#    echo >> appends without a leading newline; if the file's last line has no trailing
#    newline the new key glues onto the previous one and SSH ignores both.
printf '\n%s\n' "$(cat ~/.ssh/hermes_vps.pub)" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# 3. First connect — auto-trust the host key (normal on first connect)
ssh -i ~/.ssh/hermes_vps -o StrictHostKeyChecking=accept-new root@<hostname>
```

### Why `printf '\n%s\n'` and not `echo >>`

`echo "key" >> authorized_keys` appends without a guaranteed leading newline. If the previous
line lacked a trailing newline, the result is two keys on one line:

```
...paarth@digitalcrewssh-ed25519 AAAA...claude-code-hermes-deploy
```

SSH parses `authorized_keys` one key per line — the merged line is silently invalid.
`printf '\n%s\n'` forces separation regardless of prior file state.

**Detection:** `grep -c "^ssh-" ~/.ssh/authorized_keys` should equal the number of keys.
If it's low, keys are merged. Fix: `sed -i 's/\(digitalcrew\)\(ssh-ed25519\)/\1\n\2/' ~/.ssh/authorized_keys`

### Running remote commands once SSH works

```bash
ssh -i ~/.ssh/hermes_vps root@<hostname> 'bash -s' <<'REMOTE'
# everything here runs on the VPS
hermes --version
hermes gateway status
REMOTE
```

This is the pattern for all remote install/config/fix steps. No copy-pasting needed.

### Common SSH failure chain (in the order they appear)

| Error | Cause | Fix |
|-------|-------|-----|
| `Host key verification failed` | First connect; key not in known_hosts | Add `-o StrictHostKeyChecking=accept-new` |
| `Permission denied (publickey,password)` | Bash tool is non-interactive; can't type password | Use key-based auth (steps above) |
| Key added but still `Permission denied` | Key was added inside a container | `whoami; hostname` check; exit container; re-add on host |
| Key added on host but still denied | `echo >>` merged two keys onto one line | Use `printf '\n%s\n'`; fix merged keys with `sed` |
| SSH works but Bash tool can't reach VPS | WSL2 network isolation | Use `-o StrictHostKeyChecking=accept-new -i ~/.ssh/hermes_vps` in Bash tool |

---

## Wiring an HTTP MCP server into Hermes

Full procedure is in `skills/hermes-mcp-add/SKILL.md`. Key rules:

1. **Probe before configuring** — never trust supplied URL forms; run the 5-variant curl matrix.
2. **Initialize ≠ auth** — probe `tools/list` without auth; the error message is the spec.
3. **Placeholder token in CLI** — pipe `placeholder` through `printf | docker exec`; inject real value with `sed`.
4. **`|` delimiter in sed** — tokens contain `/+= `; use `sed 's|...|...|'` not `sed 's/.../.../'`.
5. **`gateway stop` + `gateway run`** — not `restart`; env changes need a clean re-read.
6. **Two `.env` files** — compose `.env` (container-level) vs `/opt/data/.env` (Hermes runtime). MCP secrets go in the Hermes one.

---

## Branch / PR conventions

- Branch from `main`: `<type>/<short-description>` (e.g. `feat/hermes-mcp-add`, `fix/ssh-key-merge`)
- Commit messages: `<type>(<scope>): <what> — <why>` (conventional commits)
- Every skill addition needs a `Definition of done` checklist in the skill file
- `reference/TROUBLESHOOTING.md` grows after every real failure — add the row, don't skip it

## Secrets hygiene

- Never commit tokens, passwords, or API keys
- `.env` files → `chmod 600`; add to `.gitignore` if local
- `TRAFFIC_TOKEN` secret is set in GitHub Actions secrets (not in any file)
- Rotate tokens shared in chat immediately after use
