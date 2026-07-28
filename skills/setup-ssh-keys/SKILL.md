---
name: setup-ssh-keys
description: Set up key-based SSH access from this machine to the user's VPS so every other hstack skill can run unattended. Use when any skill aborts with "SSH to $VPS_USER@$VPS_IP failed", or before the first deploy. Handles the container-vs-host trap, the merged-key corruption, and the fact that an AI agent cannot type an interactive password.
---

# /setup-ssh-keys — key-based SSH to the VPS (the prerequisite for every other skill)

You are the engineer establishing unattended SSH access from this machine to the user's
VPS. Every other hstack skill assumes this already works — all 94 of them open with the
same `BatchMode=yes` reachability check and abort here when it fails.

**The one constraint that shapes this whole skill:** your Bash tool is non-interactive.
It cannot type a password at an `ssh` prompt, and it cannot answer `ssh-copy-id`. So the
public key must reach the VPS by a route that never requires typing a password *in your
session*. Step 4 gives three such routes. Pick the first one that applies; do not try to
automate a password prompt.

Do everything autonomously; stop only for the one thing a machine cannot do — the very
first placement of a public key on a box you cannot yet log into.

---

## Before you start — gather (ask once)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS | The user's hosting control panel |
| `$VPS_USER` | SSH user, almost always `root` | The user's hosting control panel |
| `$KEY_PATH` | Where to write the keypair. Default `~/.ssh/hermes_vps` | Leave default unless the user has a convention |

Optional, only if the user wants password login switched off at the end:

| Variable | Meaning |
|----------|---------|
| `HARDEN_SSHD=1` | After key auth is proven, disable password authentication in `sshd_config` |

> If the user does not have a VPS at all, stop here. This skill cannot create one.
> Tell them plainly: they need a Linux VPS with root SSH before any hstack skill can run,
> and hstack does not provision one for them.

---

## Step 1 — confirm you are on the host, not inside a container

Run this **before anything else**, on whatever machine you believe is the target:

```bash
whoami; hostname
```

Read the result:

- `root@<readable-name>` (e.g. `root@srv-hermes-01`) → you are on the **VPS host** ✅
- `root@<hex-string>` (e.g. `root@dd635306c545`) → you are **inside a Docker container** ❌

If the hostname is a bare hex string, type `exit` and re-run the check before continuing.

This is the single most common cause of "I added the key but SSH still says permission
denied." A key added to `~/.ssh/authorized_keys` inside a container is written to the
container's filesystem. The host's `sshd` never reads that file, so the key has no
effect and no error is produced anywhere.

---

## Step 2 — idempotency check: is key auth already working?

Most invocations of this skill are re-runs. Do not generate a second keypair when a
working one exists.

```bash
if ssh -o BatchMode=yes -o ConnectTimeout=8 \
       -o StrictHostKeyChecking=accept-new \
       -i "$KEY_PATH" "$VPS_USER@$VPS_IP" 'echo ok' 2>/dev/null | grep -qx ok; then
  echo "ALREADY WORKING: key-based SSH to $VPS_USER@$VPS_IP is live. Nothing to do."
  exit 0
fi
```

`BatchMode=yes` is what makes this a real test: it forbids every interactive prompt, so
the command can only succeed via key auth. Without it, a hung password prompt looks
like a timeout and you will misdiagnose the failure.

If that printed `ALREADY WORKING`, stop. The calling skill can proceed.

---

## Step 3 — generate the keypair (local, no passphrase)

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
if [ -f "$KEY_PATH" ]; then
  echo "Keypair already exists at $KEY_PATH — reusing it, not regenerating."
else
  ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" -C "hstack-$(date +%Y%m%d)"
fi
chmod 600 "$KEY_PATH"
chmod 644 "${KEY_PATH}.pub"
cat "${KEY_PATH}.pub"
```

Notes on the flags:

- `-N ""` means no passphrase. A passphrase would reintroduce an interactive prompt on
  every connection, which defeats the entire purpose. The key is protected by file
  permissions instead, which is why `chmod 600` is not optional.
- `ed25519` over RSA: shorter, faster, and supported by every sshd from OpenSSH 6.5 (2014)
  onward. If the VPS is genuinely older than that, fall back to
  `ssh-keygen -t rsa -b 4096`.
- Never regenerate over an existing key. Doing so silently invalidates every other place
  that key was already installed.

---

## Step 4 — install the public key on the VPS (pick the first route that applies)

You cannot type a password. These are the three routes that do not require you to.

### Route A — provider control panel or cloud-init (preferred, no shell needed)

Most hosts (Hetzner, DigitalOcean, Vultr, Linode, Hostinger) accept an SSH public key in
the control panel and inject it into `root`'s `authorized_keys` on boot or on demand.

Give the user the exact string printed by Step 3 and tell them where to paste it. This is
the most reliable route because it bypasses the shell entirely and cannot produce a
merged-key file.

### Route B — the user runs one command in their own terminal

If the user already has password SSH working from their own machine, hand them exactly
this, with the public key substituted in:

```bash
ssh "$VPS_USER@$VPS_IP" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '\n%s\n' 'PASTE_PUBLIC_KEY_HERE' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

They will be prompted for the password once, in their own terminal, where typing works.

**Why `printf '\n%s\n'` and never `echo >>`:** `echo "key" >> authorized_keys` appends
with no guaranteed leading newline. If the file's last line had no trailing newline, the
new key is glued onto the end of the previous one:

```
...paarth@laptopssh-ed25519 AAAAC3NzaC1lZDI1...
```

`sshd` parses `authorized_keys` strictly one key per line. A merged line is not two
invalid keys — it is one unparseable line, and **both** keys stop working. There is no
warning in the auth log that makes this obvious. `printf '\n%s\n'` forces a leading
newline regardless of the file's prior state.

### Route C — you already have working SSH as a different user

If you can reach the box as some other user with key auth, append from there:

```bash
ssh "$OTHER_USER@$VPS_IP" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '\n%s\n' '$(cat "${KEY_PATH}.pub")' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

---

## Step 5 — verify key-based auth non-interactively

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new \
    -i "$KEY_PATH" "$VPS_USER@$VPS_IP" 'echo ok; whoami; hostname' 2>&1
```

Expected: `ok`, then the user, then a readable hostname.

`StrictHostKeyChecking=accept-new` trusts the host key on first contact and pins it
thereafter. It is the right setting here: plain `no` would keep accepting a *changed*
host key forever, which is the actual man-in-the-middle risk.

Read failures like this:

| Output | Cause | Fix |
|---|---|---|
| `Permission denied (publickey)` | Key not on the box, or landed in the wrong user's home | Re-run Step 4; confirm the target user's home directory |
| `Permission denied (publickey,password)` | sshd offered password auth; your key was rejected | Key is not in `authorized_keys`, or the file/dir permissions are wrong (Step 6) |
| `Host key verification failed` | Host key changed, or `accept-new` was omitted | Re-add the flag; if the box was rebuilt, remove the stale entry from `known_hosts` |
| Hangs, then times out | sshd unreachable, firewall, or wrong IP | Check the box is running and port 22 is open |

---

## Step 6 — verify the key file was not corrupted

Two failure modes leave key auth broken while `authorized_keys` looks fine at a glance.

**Merged keys** (from an `echo >>` somewhere in the box's history):

```bash
ssh -i "$KEY_PATH" "$VPS_USER@$VPS_IP" '
  lines=$(grep -c . ~/.ssh/authorized_keys)
  keys=$(grep -c "^ssh-" ~/.ssh/authorized_keys)
  echo "non-empty lines: $lines / lines starting with ssh-: $keys"
  [ "$lines" = "$keys" ] || echo "WARN: some keys are merged onto shared lines"
'
```

If those two numbers differ, split the merged lines:

```bash
ssh -i "$KEY_PATH" "$VPS_USER@$VPS_IP" \
  "sed -i 's|\(\S\)\(ssh-ed25519 \|ssh-rsa \)|\1\n\2|g' ~/.ssh/authorized_keys"
```

**Wrong permissions.** `sshd` silently ignores `authorized_keys` when the file or its
directory is group- or world-writable. This produces `Permission denied (publickey)` with
a perfectly correct key in place:

```bash
ssh -i "$KEY_PATH" "$VPS_USER@$VPS_IP" '
  chmod 700 ~/.ssh
  chmod 600 ~/.ssh/authorized_keys
  ls -ld ~/.ssh ~/.ssh/authorized_keys
'
```

Expect `drwx------` on the directory and `-rw-------` on the file.

---

## Step 7 — optional hardening (only when `HARDEN_SSHD=1`)

Do not run this until Step 5 has passed. Disabling password auth before key auth works
locks everyone out of the box, and recovering means a provider console session.

```bash
[ "${HARDEN_SSHD:-0}" = "1" ] || echo "Skipping sshd hardening (set HARDEN_SSHD=1 to enable)"
```

When enabled:

```bash
ssh -i "$KEY_PATH" "$VPS_USER@$VPS_IP" '
  cp /etc/ssh/sshd_config /etc/ssh/sshd_config.hstack-backup
  sed -i "s|^#\?PasswordAuthentication.*|PasswordAuthentication no|" /etc/ssh/sshd_config
  sshd -t && systemctl reload ssh 2>/dev/null || systemctl reload sshd
'
```

`sshd -t` validates the config before the reload. Without it, a typo takes sshd down on
restart and the box becomes unreachable.

Prove key auth still works immediately after, in the same session, while you still have
a console fallback:

```bash
ssh -o BatchMode=yes -i "$KEY_PATH" "$VPS_USER@$VPS_IP" 'echo still-ok'
```

---

## Step 8 — hand back to the calling skill

Report the exact values the next skill needs:

```bash
echo "SSH ready:"
echo "  key:  $KEY_PATH"
echo "  host: $VPS_USER@$VPS_IP"
echo "  test: ssh -o BatchMode=yes -i $KEY_PATH $VPS_USER@$VPS_IP 'echo ok'"
```

Every hstack skill's reachability check will now pass. Continue with whatever skill sent
the user here — usually `/hermes-deploy`.

---

## Rollback

Removing access is the only meaningful rollback. Do it by exact key match so other keys
on the box are untouched.

```bash
rollback() {
  PUB=$(cut -d' ' -f2 "${KEY_PATH}.pub")   # match on the key body, not the comment
  ssh -i "$KEY_PATH" "$VPS_USER@$VPS_IP" "
    cp ~/.ssh/authorized_keys ~/.ssh/authorized_keys.hstack-bak
    grep -v \"$PUB\" ~/.ssh/authorized_keys.hstack-bak > ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
  "
  # If sshd was hardened, restore password auth so the user is not locked out.
  ssh -i "$KEY_PATH" "$VPS_USER@$VPS_IP" '
    [ -f /etc/ssh/sshd_config.hstack-backup ] && {
      cp /etc/ssh/sshd_config.hstack-backup /etc/ssh/sshd_config
      sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)
    }
  ' || true
  rm -f "$KEY_PATH" "${KEY_PATH}.pub"
  echo "Rolled back: key removed from the VPS and deleted locally."
}
```

Match on the key body (field 2), never the comment. Comments are not unique and matching
on one can delete an unrelated key.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Adding the key while inside a Docker container | The host's sshd never reads the container's filesystem; the key has no effect and nothing errors | Step 1: `whoami; hostname` — a hex hostname means you are in a container |
| 2 | `echo "key" >> authorized_keys` | No guaranteed leading newline; the key merges onto the previous line and **both** keys silently stop working | Always `printf '\n%s\n'` (Step 4) |
| 3 | Testing with plain `ssh` instead of `BatchMode=yes` | A password prompt hangs and reads as a network timeout, so you debug the wrong layer | Every verification uses `-o BatchMode=yes` |
| 4 | Group- or world-writable `~/.ssh` or `authorized_keys` | sshd ignores the file entirely and reports `Permission denied (publickey)` with a valid key present | `chmod 700 ~/.ssh` and `chmod 600 authorized_keys` (Step 6) |
| 5 | Generating a passphrase-protected key | Reintroduces an interactive prompt on every connection; unattended skills hang forever | `ssh-keygen -N ""`, and protect via file permissions |
| 6 | Regenerating over an existing keypair | Silently invalidates the key everywhere it was already installed, including other hosts | Step 3 reuses an existing `$KEY_PATH` rather than overwriting |
| 7 | Disabling password auth before proving key auth | Locks everyone out; recovery needs a provider console session | Step 7 is gated behind `HARDEN_SSHD=1` and runs only after Step 5 passes |
| 8 | Editing `sshd_config` without `sshd -t` | A typo takes sshd down on reload and the box becomes unreachable | Always `sshd -t && reload`, and keep the backup file |
| 9 | Trying to automate the first password login | The Bash tool is non-interactive; `ssh-copy-id` and password prompts cannot be scripted here | Route A (control panel) or Route B (user's own terminal) in Step 4 |
| 10 | `StrictHostKeyChecking=no` instead of `accept-new` | `no` keeps accepting a *changed* host key forever, which is the real MITM exposure | Use `accept-new`: trust on first use, pin thereafter |
| 11 | Key installed for the wrong user | Root's `authorized_keys` is `/root/.ssh/`, not `/home/<user>/.ssh/` | Verify with `whoami` over the new key in Step 5 |
| 12 | WSL2 reaching the VPS differently than the host shell | Different network namespace; a key that works in one may not be found in the other | Always pass `-i "$KEY_PATH"` explicitly rather than relying on the agent or defaults |

---

## Definition of done

- [ ] Confirmed the target is the VPS host, not a container (`whoami; hostname` shows a readable hostname)
- [ ] Idempotency check ran first; no second keypair was generated over a working one
- [ ] Keypair exists at `$KEY_PATH` with `600` on the private key and `644` on the public key
- [ ] Public key installed on the VPS via Route A, B, or C — never by scripting a password prompt
- [ ] `ssh -o BatchMode=yes -i $KEY_PATH $VPS_USER@$VPS_IP 'echo ok'` returns `ok`
- [ ] `grep -c "^ssh-" ~/.ssh/authorized_keys` equals the non-empty line count (no merged keys)
- [ ] `~/.ssh` is `700` and `~/.ssh/authorized_keys` is `600` on the VPS
- [ ] If `HARDEN_SSHD=1`: `sshd -t` passed, and key auth was re-verified after the reload
- [ ] Rollback function defined, and the private key path reported back to the calling skill

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for the full SSH
failure chain in the order the errors appear.
