---
name: hermes-integrate
description: Wire several apps into a self-hosted Hermes v0.22.5 in one sitting. Presents the integration catalog, validates the picks, refuses specialists that are still legacy procedures, runs each /integration-NAME skill one at a time with the credentials collected up front, then verifies every MCP server with `mcp test` and the gateway with `gateway ensure`. Use when the user wants to connect more than one app. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-integrate — connect several apps to a remote Hermes (SSH-first orchestrator)

You are the engineer connecting the user's apps to their self-hosted Hermes agent on a VPS. The agent (Hermes, Codex,
Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to a remote VPS over SSH as root.

Each integration has its own skill (`/integration-NAME`) that knows the vendor's endpoint, auth shape, MCP availability and
pitfalls, runs a live vendor check before it writes anything, and rolls itself back on failure. This skill is only the
**orchestrator**: it helps the user choose, checks that every chosen specialist can run safely on Hermes 0.22.5, collects the
credentials in one batch, runs the specialists strictly one after another, and verifies the result natively.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly macOS, bash 3.2) and reaches the
VPS through the `remote` helper from Step 0, which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on the remote
PATH. Run all blocks in ONE shell session: later steps call the Step 0 functions.

Do everything autonomously; stop only for what a machine cannot do: minting tokens, sharing a page with an integration,
approving an OAuth sign-in.

**What this skill deliberately does not do (all of it was in the legacy version).**

- **It never writes a secret.** Writing every token first, with `config set 'VAR' 'VALUE'` in an ssh command line, ran before
  any vendor check and exposed the tokens in `ps`. Each specialist writes its own secret over ssh stdin, after its own live
  preflight.
- **It does not pass shortcuts such as `--no-reload` or `--secret-already-written`.** No specialist has such an option
  (`/blueprint-install` makes the same point), and `/integration-NAME` is a skill the agent runs, not a command a shell can
  call.
- **It does not batch the gateway reload.** Every specialist that registers an MCP server ends with its own
  `gw_reload` (`gateway restart --detach`, then `gateway ensure --json` until a NEW instance is ready). Wiring N apps therefore
  restarts the gateway up to N times. A restart with live chats and no terminal is refused unless `GW_INTERRUPT=1` is set, so a
  batch can stop halfway: pick a quiet moment, or set `GW_INTERRUPT=1` for the whole batch only if interrupting chats is
  acceptable. This skill ends with a readiness check, not another reload.
- **It never removes an earlier integration after a later failure.** The failing specialist restores its own pre-run
  `.env`/`config.yaml`; the ones that finished stay. Undo one with that specialist's own Rollback section.
- **It does not run legacy specialists by default.** Only the integrations that have been re-verified for Hermes 0.22.5
  are safe to run. The others still carry the marker `> **Compatibility:** legacy procedure written for Hermes 0.15.x` and may
  use commands that do not exist on 0.22.5 (their old gateway reload recipe in particular).

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | User's hosting dashboard |
| `$CHOSEN` | The integrations to wire, comma or space separated (for example `notion, github`) | Pick from the catalog in Step 2 |
| one credential per pick | Each specialist names its own variable and where to mint it | The specialist's "Before you start" table |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 0 — helpers (define first, so nothing can fail before they exist)

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=hermes-integrate
# Non-login ssh shells miss ~/.local/bin, where the Hermes installer puts `hermes`.
remote() { ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }
# gw_ready [SECONDS]: native readiness. Succeeds only when `gateway ensure --json` exits 0 and reports "state":"ready"
# (the transient pending/draining codes 5 and 6 are retried twice). It never greps `gateway status` text, because the stopped
# gateway prints "✗ Gateway is not running", which contains "running".
gw_ready() {
  remote "T=${1:-60} bash -s" <<'REMOTE'
n=0
while :; do
  out=$(hermes -p default gateway ensure --json --timeout "$T") && rc=0 || rc=$?
  [ "$rc" = 0 ] && break
  n=$((n + 1))
  { [ "$rc" = 5 ] || [ "$rc" = 6 ]; } && [ "$n" -lt 3 ] || { printf '%s\n' "$out" >&2; exit 1; }
  sleep 3
done
case $out in *'"state":"ready"'*) printf '%s\n' "$out" ;; *) printf '%s\n' "$out" >&2; exit 1 ;; esac
REMOTE
}
# gw_reload: restart the default-profile gateway natively and require a ready gateway with a NEW instance_id.
# `--detach` keeps `restart` from running the gateway inside the ssh shell when no service is installed. With live
# sessions and no terminal, restart refuses; GW_INTERRUPT=1 adds -y and interrupts them deliberately (never set by default).
# Side effect: the pre-restart `ensure` read that captures the old instance_id STARTS a gateway when none is running (ensure never
# installs a service, but it does start one). A reload implies the gateway should run, so that is accepted; read-only skills never call gw_reload.
gw_reload() {
  local old new out interrupt
  interrupt=""
  if [ "${GW_INTERRUPT:-0}" = 1 ]; then interrupt=1; fi
  # Keep an endpoint identity even when ensure exits 6 (draining/restart_wait).
  out=$(remote 'hermes -p default gateway ensure --json --timeout 10 2>/dev/null') || :
  old=$(printf '%s\n' "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')
  remote "hermes -p default gateway restart --detach${interrupt:+ -y}" \
    || { echo "gw_reload: gateway restart failed or was refused (live sessions? re-run with GW_INTERRUPT=1 only if interrupting them is acceptable)." >&2; return 1; }
  out=$(gw_ready) || return 1
  new=$(printf '%s' "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')
  if [ -n "$old" ] && [ "$new" = "$old" ]; then echo "gw_reload: the gateway instance did not change, so it was not restarted." >&2; return 1; fi
  printf '%s\n' "$out"
}
```

This skill writes nothing to Hermes, so it carries no `snapshot`/`rollback`: the specialists own those. `gw_ready` is used in
Step 5; `gw_reload` is defined with the other shared helpers and is not called here.

**Gateway lifecycle (Hermes v0.22.5).** `gw_reload` runs `hermes -p default gateway restart --detach` and then requires `gw_ready`,
which is `gateway ensure --json --timeout 60` exiting 0 with `"state":"ready"` and a different `instance_id` than before. Why this shape
(source-verified, not live-verified):

- `gateway restart` restarts the installed systemd/launchd service, or, with no service, stops the profile's gateway and runs the
  replacement **in the calling shell**; `--detach` starts it in the background the way `ensure` does, so an ssh call cannot hang
  (`hermes_cli/gateway.py:5454-5536`, `hermes_cli/gateway_supervised_restart.py:140-151`, `hermes_cli/gateway_runtime_start.py:86-97`).
- With live sessions it asks y/N on a TTY and **refuses with exit 1 without one**; `-y`/`--yes` interrupts them
  (`hermes_cli/gateway_lifecycle_guards.py:97-129`, `hermes_cli/subcommands/gateway.py:146-155`). The helper never adds `-y`
  on its own: set `GW_INTERRUPT=1` only when interrupting live chats is acceptable. Do not use `--force` or `--all` to evade a refusal.
- `gateway ensure` never installs a service; it starts an installed one or spawns an unmanaged daemon, and exits 0 only when the
  gateway is ready (5 deadline/starting, 6 draining, 3 incompatible, 4 authorization, 7 conflict)
  (`hermes_cli/gateway_runtime.py:390-495`, `hermes_cli/gateway_runtime_cli.py:8-37`). `instance_id` is a fresh uuid per gateway process
  (`gateway/run_runtime.py:144`), which is how `gw_reload` notices a restart that silently did nothing.
- `gateway status` prints `✗ Gateway is not running` when stopped (exit 0), so its text is never used as a health check.
- A restarted gateway process loads `~/.hermes/.env` at start (`gateway/run.py:1583-1585`; it is also reloaded per turn outside
  multiplex mode, `:1588-1600`), so `restart` does re-read `.env`; config.yaml and MCP changes need the reload too.
- The recipe assumes the exclusive default profile and its one host gateway; named-profile and shared-host deployments are out of scope.
  The foreground command is `gateway run`; no daemon flag exists on any gateway subcommand.

---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS

```bash
HERMES_BANNER=$(remote '
  set -e
  command -v hermes >/dev/null 2>&1 \
    || { echo "FAIL: hermes not found on the VPS host PATH; container-only installations are outside this procedure"; exit 1; }
  hermes -p default --version
') || { echo "ABORT: Hermes is not installed on the VPS host account (container-only installs are unsupported). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
```

Expected: a banner naming Hermes `0.22.5` (the version pinned as `HERMES_VERSION` in `VERSIONS.txt`). The procedure is checked
against the v0.22.5 source; it has not been run against a live host.

---

## Step 2 — present the catalog, validate the picks, check each specialist

Show the table and ask once which services to connect. Most users pick 3 to 5. Accept names or a whole category.

| Category | Integrations (`/integration-NAME`) |
|----------|-----------------------------------|
| Memory | mem0 · supermemory (pick one) |
| Database | supabase · postgres · neon · redis |
| Vector | pinecone · qdrant |
| Auth | auth0 · clerk |
| Observability | posthog · sentry · datadog · segment |
| RAG / code / storage | firecrawl · e2b · r2 |
| AI tools | openai-tools · elevenlabs · replicate |
| CRM | hubspot · salesforce · pipedrive · zoho-crm |
| Docs & notes | notion · google-workspace · microsoft-365 · obsidian |
| Dev | github · gitlab · bitbucket |
| Project management | jira · linear · asana · clickup · monday · trello · airtable |
| Cloud | aws · gcp · azure · digitalocean · hetzner · cloudflare · vercel · netlify · railway · render |
| Payments | stripe · paypal · razorpay |
| Commerce | shopify · woocommerce · webflow · wordpress |
| Email | mailchimp · brevo · sendgrid · postmark |
| Support & messaging | twilio · sendbird · intercom · zendesk · freshdesk |
| Forms & scheduling | typeform · tally · calendly · zoom |
| Search | brave-search · tavily · exa |

Do not re-implement what Hermes already does natively: model providers are `/hermes-model`, messaging platforms are the
`platform-*` skills, and a server that is only in the Hermes MCP catalog (and has no `/integration-NAME`) is
`/hermes-mcp-add`. The block validates the picks (nothing is trusted from the user's text), keeps their order, removes
duplicates, and looks for each specialist in the skill folders of the usual agents on THIS machine. It reads files only.

```bash
KNOWN="mem0 supermemory supabase postgres neon redis pinecone qdrant auth0 clerk posthog sentry datadog segment firecrawl e2b openai-tools elevenlabs replicate r2 hubspot salesforce pipedrive zoho-crm notion google-workspace microsoft-365 obsidian github gitlab bitbucket jira linear asana clickup monday trello airtable aws gcp azure digitalocean hetzner cloudflare vercel netlify railway render stripe paypal razorpay shopify woocommerce webflow wordpress mailchimp brevo sendgrid postmark twilio sendbird intercom zendesk freshdesk typeform tally calendly zoom brave-search tavily exa"
PLAN=""
set -f   # a stray * in CHOSEN must not expand to file names
for raw in $(printf '%s' "${CHOSEN:-}" | tr ',' ' ' | tr 'A-Z' 'a-z'); do
  case "$raw" in
    ""|*[!a-z0-9-]*|-*) echo "ABORT: '$raw' is not an integration name (lowercase letters, digits and dashes). Nothing was written."; exit 1 ;;
  esac
  case " $KNOWN " in
    *" $raw "*) ;;
    *) echo "ABORT: '$raw' is not in the hstack integration catalog above. Nothing was written."; exit 1 ;;
  esac
  case " $PLAN " in *" $raw "*) ;; *) PLAN="$PLAN $raw" ;; esac
done
set +f
PLAN=$(printf '%s' "$PLAN" | sed 's/^ *//')
[ -n "$PLAN" ] || { echo "ABORT: CHOSEN is empty. Pick at least one integration from the catalog. Nothing was written."; exit 1; }

# local_skill_file NAME: the installed SKILL.md of integration-NAME in the skill folders of Claude Code, Codex, Hermes or OpenClaw.
local_skill_file() {
  local d
  for d in "$HOME/.claude/skills" "$HOME/.agents/skills" "$HOME/.hermes/skills" "$HOME/.openclaw/skills"; do
    if [ -f "$d/integration-$1/SKILL.md" ]; then printf '%s' "$d/integration-$1/SKILL.md"; return 0; fi
  done
  return 1
}
LEGACY=""
for n in $PLAN; do
  if f=$(local_skill_file "$n"); then
    if grep -q '^> \*\*Compatibility:\*\* legacy procedure' "$f"; then LEGACY="$LEGACY $n"; fi
  else
    echo "NOTE: integration-$n is not installed in a known skill folder on this machine; read its SKILL.md where your agent keeps it and check it for the legacy marker before running it."
  fi
done
LEGACY=$(printf '%s' "$LEGACY" | sed 's/^ *//')
if [ -n "$LEGACY" ] && [ "${ALLOW_LEGACY:-0}" != 1 ]; then
  echo "ABORT: still legacy procedures, not re-verified for Hermes 0.22.5 (their reload step may call commands that do not exist): $LEGACY."
  echo "       Drop them from CHOSEN, or set ALLOW_LEGACY=1 only if the user accepts running an unverified procedure. Nothing was written."
  exit 1
fi
[ -z "$LEGACY" ] || echo "WARN: ALLOW_LEGACY=1: running unverified legacy specialists: $LEGACY"
echo "Plan (in this order): $PLAN"
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) picks validated, specialists checked, nothing written yet
  For each of: $PLAN  (strictly one after another, never in parallel)
    1. Run its /integration-NAME skill with its own credential. It checks the vendor live BEFORE writing, snapshots
       ~/.hermes/.env and config.yaml, writes the secret over ssh stdin, registers the server, reloads the gateway,
       verifies, and rolls itself back on any failure.
    2. Record it as done only after that skill's Definition of done is satisfied.
  Gateway restarts: up to one per specialist that registers an MCP server (each specialist reloads on its own).
  At the end: mcp test for every wired server and gateway ensure (readiness).
  This skill itself writes no secret and removes nothing.
Credentials are NEVER printed.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 4 — run the specialists one at a time

Ask for every credential in ONE message (one per pick; each specialist's "Before you start" table names its variable and mint
URL), then work down the plan. The tracker below lets you resume after a failure without repeating finished specialists.

```bash
DONE=""
next_specialist() {  # first name in PLAN that is not DONE; fails when everything is done
  local n
  for n in $PLAN; do
    case " $DONE " in *" $n "*) ;; *) printf '%s' "$n"; return 0 ;; esac
  done
  return 1
}
mark_done() { DONE="$(printf '%s %s' "$DONE" "$1" | sed 's/^ *//')"; }
```

For each `NEXT=$(next_specialist)`: run `/integration-NEXT` end to end (its own Step 0 helpers, preflight, snapshot, write, register,
reload, verify). When its Definition of done is satisfied, call `mark_done NEXT` and take the next one. If a specialist fails:
STOP the batch. It has already restored its own `.env`/`config.yaml` and, if it can, the gateway; tell the user which one failed
and why, leave the finished ones alone, and let the user decide whether to fix and resume (`next_specialist` picks up where
you stopped) or to undo a finished one with that specialist's own Rollback.

Run them in series: two specialists editing `config.yaml` and restarting the gateway at the same time clobber each other.
An integration that needs a human step (sharing a Notion page, approving an OAuth sign-in, installing a GitHub App) is not
done until that step is: an empty result from its smoke test is a setup step, not a wiring failure.

---

## Step 5 — verify the whole batch natively

`mcp test NAME` connects to a registered server and lists its tools (exit 0 connected, 1 failed, 3 unknown name); the readiness
check is `gateway ensure --json` (exit 0 with `"state":"ready"`). A REST-only integration registers no MCP server, so it has no
row to test; its own smoke test is its verification.

```bash
BAD=0
MCP_ROWS=$(remote 'hermes -p default mcp list' </dev/null 2>/dev/null)
for n in $DONE; do
  if printf '%s\n' "$MCP_ROWS" | awk -v n="$n" '$1==n{f=1} END{exit !f}'; then
    if remote "hermes -p default mcp test $n" </dev/null >/dev/null 2>&1; then
      echo "OK: $n connected."
    else
      echo "FAIL: mcp test $n did not connect. Run \`hermes -p default mcp test $n\` for the reason; its own Rollback undoes it."
      BAD=1
    fi
  else
    echo "NOTE: no MCP server named $n is registered (a REST-only integration, or the specialist used another name); rely on its own smoke test."
  fi
done
gw_ready >/dev/null || { echo "FAIL: the gateway is not ready (gateway ensure). See \`hermes -p default logs gateway -n 50\`."; BAD=1; }
[ "$BAD" = 0 ] || exit 1
```

---

## Step 6 — report to the user

Say plainly what is wired, what is pending and what the user still has to do by hand. New chat sessions load the tools at their
start; a running chat needs `/reload-mcp`.

```bash
PENDING=""
for n in $PLAN; do case " $DONE " in *" $n "*) ;; *) PENDING="$PENDING $n" ;; esac; done
echo "Wired and verified: ${DONE:-none}"
echo "Not finished:       ${PENDING:- none}"
echo "Next: start a new chat (or /reload-mcp) so the tools load, then run /hermes-status."
```

---

## Rollback

This skill changes nothing itself, so it has nothing of its own to roll back. Every specialist snapshots `~/.hermes/.env` and
`config.yaml` before its first write and restores them (and reloads the gateway) when one of its steps fails; that already
happened by the time you see a failure. To undo a specialist that finished, use the "undo a finished run" block of THAT
skill (it moves its `.prev` snapshot back and restores it). Do not remove several integrations in one sweep: this run may not
be what created them.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Writing all tokens first | Unvalidated tokens land in `.env` and in `ps`; one typo replaces a working token | Each specialist validates live and writes its own secret over stdin |
| 2 | Calling `/integration-NAME --no-reload` or `--secret-already-written` | No such options exist; a shell cannot run a skill | Run the specialist's blocks as written |
| 3 | Expecting a single gateway reload | Every specialist reloads itself | Say so in the dry run; quiet window or deliberate `GW_INTERRUPT=1` |
| 4 | A live-session refusal in the middle of a batch | `gateway restart` refuses without a terminal while chats are live | Stop, tell the user, resume with `next_specialist` |
| 5 | Parallel specialists | Two writers on `config.yaml` and two restarts | One at a time |
| 6 | Running a legacy specialist | Its reload or `mcp add` form may not exist on 0.22.5 | Step 2 refuses unless `ALLOW_LEGACY=1` |
| 7 | Removing everything after a late failure | Deletes integrations this run did not create | Never; the failing specialist rolls only itself back |
| 8 | Matching `mcp list` by substring | `git` matches `github` | Match the exact first column (Step 5) |
| 9 | Treating "no MCP row" as failure | REST-only integrations have no server | Reported as a NOTE |
| 10 | Wiring a provider or a chat platform here | They have native skills | `/hermes-model`, `platform-*` |
| 11 | Fresh shell per command (some harnesses) | Step 0 functions and `PLAN`/`DONE` are lost | Re-run Steps 0, 2 and 4 first |
| 12 | Asking for credentials one at a time | Burns the user's attention | One batch in Step 4 |

---

## Definition of done

- [ ] SSH confirmed; Hermes banner names `0.22.5`
- [ ] `CHOSEN` validated against the catalog; no extra integration was added
- [ ] Every specialist checked for the legacy marker; legacy ones dropped (or `ALLOW_LEGACY=1` accepted by the user)
- [ ] Dry run shown (including the restart count); user approved (or `AUTO_APPROVE=1`)
- [ ] Each `/integration-NAME` ran to its own Definition of done, one at a time; a failure stopped the batch
- [ ] `mcp test` exits 0 for every wired MCP server; REST-only ones rely on their own smoke test
- [ ] `gateway ensure` reports a ready gateway
- [ ] No secret was written, printed or passed on a command line by this skill

---

## Verified against Hermes v0.22.5

Read from the v0.22.5 source (tag `v0.22.5`, commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to the
repository root of that tag, except `skills/` and `install.sh`, which are this repository.

- `mcp list` (one row per server, first column the name) and `mcp test` (exit 0/1/3): `hermes_cli/mcp_config.py:744-805,836-880`.
- `gateway ensure --json` readiness and its exit codes; `gateway restart` refusing with live sessions and no terminal:
  `hermes_cli/subcommands/gateway.py:121-155`, `hermes_cli/gateway_lifecycle_guards.py:97-129`,
  `hermes_cli/gateway_runtime.py:390-495`. A running chat loads MCP tools at session start and `/reload-mcp` reloads them:
  `hermes_cli/commands.py` (`CommandDef("reload-mcp", ...)`).
- The specialists' own contract (`--no-reload` and friends do not exist): `skills/blueprint-install/SKILL.md` Step 5; the catalog
  of integrations: `install.sh` (`tier_members`) and `skills/integration-*`.

**Not verified:** nothing here was run against a real Hermes or a vendor; the legacy-marker check only sees specialists
installed in the four skill folders it searches. Unknown: how many restarts a given specialist performs (read its Step 7), and
whether a REST-only specialist leaves anything for `mcp test` to find.

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
