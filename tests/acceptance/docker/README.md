# Docker target for the acceptance tests (gated)

A container running a **real `sshd`** acts as the VPS. The host drives it with the **real `ssh` binary**:

- the shipped `SshTransport` (`ssh -o BatchMode=yes operator@127.0.0.1 '<remote string>'`) runs the acceptance
  transaction against it;
- the real fenced `bash` blocks of `skills/platform-telegram/SKILL.md` run on the host with the skill's own
  `remote()`, `VPS_USER=operator`, `VPS_IP=127.0.0.1`.

```
HSTACK_DOCKER=1 node --test tests/acceptance/docker/     # needs docker, ssh, ssh-keygen, node >= 18, python3, bash
node --test tests/acceptance/docker/                     # every test is SKIPPED: "skipped: HSTACK_DOCKER=1 not set"
HSTACK_DOCKER=1 HSTACK_DOCKER_KEEP=1 node --test ...     # keep the built image for faster re-runs
```

If `HSTACK_DOCKER=1` is set but `docker info` fails, the tests are skipped with that reason. A gated test is
never reported as passed when it did not run. The first run builds the image (`ubuntu:24.04` + `apt`: minutes);
the image is removed at the end unless `HSTACK_DOCKER_KEEP=1`.

## What is real and what is a test double

| piece | real or double |
|-------|----------------|
| `sshd`, key auth, non-login non-interactive shell, PATH rules, non-root user, process table | **real** |
| `ssh` client and `SshTransport` argv | **real** (a wrapper only prepends `-F /dev/null -p <port> -i <key> -o StrictHostKeyChecking=no ...`) |
| `hstack-target.sh`, the skill's bash | **real** (the shipped files) |
| `hermes` | **bash test double** `tests/acceptance/stubs/hermes`, installed only at `/home/operator/.local/bin/hermes` |
| `curl` / Telegram | **bash test double** `image/curl-stub` (answers `getMe` for one fake token; logs the token *length*). The container also resolves `api.telegram.org`, `api.github.com`, `github.com` to `127.0.0.1` |
| `image/hermes-tg-shim` | in front of the stub **only for the Telegram test**: `config set K -- V`, `gateway status`, `logs gateway -n N`. These are assumptions about Hermes, not evidence about it |

## Isolation

- sshd is published on `127.0.0.1` only, on a random free host port (`docker run -p 127.0.0.1::22`); only a public key
  enters the container.
- A throwaway ed25519 key pair is made per run under `os.tmpdir()`. The host's `~/.ssh`, ssh-agent, `known_hosts`
  and ssh config are never read (`-F /dev/null`, `IdentitiesOnly`, `IdentityAgent=none`, no `SSH_AUTH_SOCK`,
  `HOME` = a temp dir for children).
- Container, key dir and (unless `HSTACK_DOCKER_KEEP=1`) image are removed at the end, also on exit/SIGINT.
- Stub knobs (`HSTACK_STUB_FAIL`, ...) reach the container through `ssh -o SendEnv=...` + `AcceptEnv`, a fixed
  allow-list in `image/sshd_config`.

## Tests (`docker-target.test.mjs`, 12)

1. sshd reachable via the wrapper; loopback-only, key-only (`sshd -T`), non-root.
2. **PATH negative control**: plain `ssh host hermes --version` exits 127 (command not found; hermes is in no system
   dir); **positive control**: with the `export PATH="$HOME/.local/bin:$PATH"` prefix it prints the pin from `VERSIONS.txt`.
3. The wrapper leaves the `SshTransport` argv exactly as shipped.
4. `/proc` argv sampler positive control (a canary placed in argv *is* seen), so "no secret in argv" is meaningful.
5. Transaction: inspect leaves `~/.hermes` and the whole home byte-identical (hash before/after via a separate ssh) and
   the script travels as `bash -s -- inspect`; helper install, backup, put-env (secret on stdin), stage, apply, verify
   with an observer that fires the cron job over ssh and reads the stub outbox => `verified`; the receipt validates,
   says `transport_used: ssh`, contains no synthetic secret; no secret in any host ssh argv, any target process argv
   (sampled from `/proc/*/cmdline`), or the hermes argv log; secrets only in `.env` (mode 600) and `.hermes/.hstack/`.
6. Forced `cron-create` / `gateway-run` failure after apply => `rollback_required` => `restored_verified`; the prior
   secret is back byte-for-byte (sha256 computed *inside* the container); unrelated skill dir, env keys and cron job untouched.
7. A user edit of a managed key after apply => `manual_recovery_required`, nothing overwritten, nothing deleted.
8. Telegram skill (real blocks, Steps 0-9): bad token aborts at the gate before any write; good token => the curl
   double saw the *expanded* token length (no literal `$TELEGRAM_BOT_TOKEN`, token not in curl argv), allowlist and
   token in `~/.hermes/.env` mode 600 (allowlist first), token in no ssh argument; rerun without `FORCE` is a no-op;
   `FORCE=1` with a forced gateway failure restores the old token and `config.yaml` byte-for-byte.

Harness shims in the Telegram test (documented in the test file): host-side `sleep` is a no-op (pacing only), the
blocks are concatenated into one `/bin/bash` script (one shell session, as the skill requires), and the container gets
the curl double and the hermes shim. The "Rollback" appendix blocks are not run (manual / destructive).

## Not covered here

A real Hermes (including whether its CLI matches the declared adapter surface), a real VPS, systemd / service
lifecycle (`service_manager` is `none` in a container), a real Telegram bot or GitHub token, and network egress behaviour.
