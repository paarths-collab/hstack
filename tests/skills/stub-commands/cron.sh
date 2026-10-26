#!/bin/bash
# shellcheck shell=bash disable=SC2154
# (sourced by the hermes stub: H, K, event, inject and gw_state come from it)
# Test behaviour of `hermes cron ...`, sourced by the hermes stub ($@ starts at "cron"; -p already removed).
# SYNTAX is checked by the real vendored v0.22.5 argparse before this runs. BEHAVIOUR is an assumption written from the source's output
# strings and checks (hstack hermes-cron rewrite), NOT evidence about a running Hermes:
#   create   hermes_cli/cron.py:790-812 prints "Created job: <id>" then "  Name: ..", "  Schedule: ..", optional "  Script:" /
#            "  Mode: no-agent (script stdout delivered directly)", then "  Next run: ..". Failure prints "Failed to create job: <error>" and
#            exits 1. Checks, in the order of tools/cronjob_tools.py:642-702 and cron/jobs.py:1825-1855: no-agent needs a script; otherwise a
#            prompt (or skill) is required; the prompt threat scan (tools/cronjob_prompt_scan.py:30-40, subset); the script must be a
#            RELATIVE path of an existing file under ~/.hermes/scripts/ (tools/cronjob_job_args.py:416-437); the schedule parser
#            (cron/jobs.py:783-856: bare "30m" = recurring interval, "in 30m" = one-shot, "every 2h", 5-field cron, ISO timestamp);
#            the gateway lifecycle guard over prompt + script text (cron/lifecycle_guard.py:30-67, 1231-1270; subset of the regexes, run
#            both on the raw text and with `-p NAME` removed). The id is 12 hex chars (cron/jobs.py:1840). Jobs are NOT deduplicated by name.
#   list     hermes_cli/cron.py:177-262: banner, then per job "  <id> [active|paused]" and rows "    Label:" padded to 11 chars:
#            Name, Schedule, Repeat, Next run, Deliver, then Script / Mode when set. The PROMPT is never printed. Disabled jobs only with --all.
#            Empty: "No scheduled jobs in profile 'default'." ; a scheduler warning follows when the gateway is not running.
#   run      hermes_cli/cron.py:858-904: "Triggered job: <name> (<id>)" + "  Ran now: succeeded|failed." ; the stub executes the script of a
#            no-agent job synchronously (bash, from the scripts dir) and "  It will run on the next scheduler tick." for an agent job.
#   remove   "Removed job: <name> (<id>)" ; unknown reference: "Failed to remove job: Job with ID or name 'X' not found. ..." exit 1.
#   pause / resume  "Paused job: .." / "Resumed job: ..". status / doctor: shape only (doctor exits 1 when a script is missing).
# Jobs are directories under ~/.hermes/cron/jobs/<id>/ (one file per field), so a test can read the stored prompt.
# Knobs: fail.cron.create (create exits 1 before storing), cron_no_croniter (5-field cron expressions are rejected like a host
# without the croniter package, cron/jobs.py:769-771), cron_list_fail (list exits 1), cron_list_hide (list always shows no jobs even
# though they exist: models a job store that cannot be read back).
cron_guard_hit() { # TEXT -> 0 when the lifecycle guard would block it (subset of cron/lifecycle_guard.py:30-67)
  local t=$1 n
  n=$(printf '%s' "$t" | sed -E 's/(^|[[:space:]])(-p|--profile)[[:space:]]+[^[:space:]]+//g')
  local x
  for x in "$t" "$n"; do
    printf '%s\n' "$x" | grep -Eiq '(^|[^/[:alnum:]_.-])hermes(\.(exe|cmd|bat|com|ps1))?[[:space:]]+gateway[[:space:]]+(restart|stop|uninstall)([^[:alnum:]_]|$)' && return 0
    printf '%s\n' "$x" | grep -Eiq 'launchctl[[:space:]]+(kickstart|unload|load|stop|restart|submit|bootstrap|bootout|remove|disable)[^[:cntrl:]]*hermes[.-]?gateway' && return 0
    printf '%s\n' "$x" | grep -Eiq 'systemctl[[:space:]]+(-[^[:space:]]+[[:space:]]+)*(restart|stop|start)[^[:cntrl:]]*hermes[.-]?gateway' && return 0
    printf '%s\n' "$x" | grep -Eiq '(^|[^[:alnum:]_])(p?kill|taskkill|stop-process)([^[:alnum:]_]|$)[^[:cntrl:]]*hermes[^[:cntrl:]]*gateway' && return 0
    printf '%s\n' "$x" | grep -Eiq '(^|[^[:alnum:]_])(p?kill|taskkill|stop-process)([^[:alnum:]_]|$)[^[:cntrl:]]*gateway[^[:cntrl:]]*hermes' && return 0
  done
  return 1
}
cron_prompt_threat() { # PROMPT -> prints the threat id, 0 when blocked (subset of tools/cronjob_prompt_scan.py:30-40)
  local p=$1
  printf '%s\n' "$p" | grep -Eiq 'ignore[[:space:]]+([[:alnum:]_]+[[:space:]]+)*(previous|all|above|prior)[[:space:]]+([[:alnum:]_]+[[:space:]]+)*instructions' && { echo prompt_injection; return 0; }
  printf '%s\n' "$p" | grep -Eiq 'cat[[:space:]]+[^[:cntrl:]]*(\.env|credentials|\.netrc|\.pgpass|id_rsa|id_ed25519|id_ecdsa)' && { echo read_secrets; return 0; }
  printf '%s\n' "$p" | grep -Eiq 'authorized_keys' && { echo ssh_backdoor; return 0; }
  printf '%s\n' "$p" | grep -Eiq 'rm[[:space:]]+-rf[[:space:]]+/' && { echo destructive_root_rm; return 0; }
  return 1
}
cron_parse_schedule() { # SCHEDULE -> prints the display form, 0 ok ; error text on stdout + return 1 (cron/jobs.py:783-856)
  local s lower
  s=$(printf '%s' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'); lower=$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    every\ *)
      cron_duration "${lower#every }" && { echo "every $CRON_MINUTES"m; return 0; }
      echo "Invalid duration: '${lower#every }'. Use format like '30m', '2h', '1d', or a bare unit like 'hour' (defaults to 1)."; return 1 ;;
    in\ *)
      cron_duration "${lower#in }" && { echo "once in ${lower#in }"; return 0; }
      echo "Invalid duration '${lower#in }' after 'in '. Use e.g. 'in 30m', 'in 2h'."; return 1 ;;
  esac
  if printf '%s\n' "$s" | grep -Eq '^([A-Za-z0-9*/,-]+[[:space:]]+){4,5}[A-Za-z0-9*/,-]+$'; then
    [ -f "$HOME/knobs/cron_no_croniter" ] && { echo "Cron expressions require 'croniter' package. Install with: pip install croniter"; return 1; }
    echo "$s"; return 0
  fi
  if printf '%s\n' "$s" | grep -Eq 'T|^[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
    printf '%s\n' "$s" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.+-]+)?$' && { echo "once at ${s%%T*}"; return 0; }
    echo "Invalid timestamp '$s': Invalid isoformat string"; return 1
  fi
  cron_duration "$lower" && { echo "every $CRON_MINUTES"m; return 0; }
  printf "Invalid schedule '%s'. Use:\n  - Interval: '30m', 'every 30m', 'every 2h' (recurring)\n  - One-shot delay: 'in 30m', 'in 2h' (fires once)\n  - Weekly/daily: 'every monday 9am', 'weekdays at 9am' (recurring)\n  - Cron: '0 9 * * *' (cron expression)\n  - Timestamp: '2026-02-03T14:00:00' (one-shot at time)\n" "$1"
  return 1
}
cron_duration() { # "30m" "2h" "1d" "hour" -> CRON_MINUTES (cron/jobs.py:673-682)
  local d=$1 num unit
  printf '%s\n' "$d" | grep -Eq '^[0-9]*[[:space:]]*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$' || return 1
  num=$(printf '%s' "$d" | sed -E 's/[^0-9].*$//'); [ -n "$num" ] || num=1
  unit=$(printf '%s' "$d" | sed -E 's/^[0-9]*[[:space:]]*//' | cut -c1)
  case "$unit" in m) CRON_MINUTES=$((num)) ;; h) CRON_MINUTES=$((num * 60)) ;; d) CRON_MINUTES=$((num * 1440)) ;; esac
  return 0
}
cron_find() { # REF -> prints the job dir (exact id first, then case-insensitive name); 1 when absent
  local d nm ref=$1 low
  [ -n "$ref" ] && [ -d "$HOME/.hermes/cron/jobs" ] || return 1
  [ -d "$HOME/.hermes/cron/jobs/$ref" ] && { echo "$HOME/.hermes/cron/jobs/$ref"; return 0; }
  low=$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]')
  for d in "$HOME/.hermes/cron/jobs"/*; do
    [ -d "$d" ] || continue
    nm=$(tr '[:upper:]' '[:lower:]' < "$d/name")
    [ "$nm" = "$low" ] && { echo "$d"; return 0; }
  done
  return 1
}
cron_warn_sched() {
  [ "$(cat "$HOME/.hermes/gateway.state" 2>/dev/null || echo stopped)" = running ] && return 0
  echo "  ⚠  Scheduler is not ready for profile 'default': no gateway serves it and no fresh ticker heartbeat."
}
hermes_cmd() {
  local H=$HOME/.hermes J=$HOME/.hermes/cron/jobs
  local sub=${2:-list}
  [ $# -ge 2 ] && shift 2 || shift 1
  mkdir -p "$J"
  case "$sub" in
    create|add)
      local schedule="" prompt="" havep=0 name="" deliver="" script="" noagent=0 paused=0 skills=0 arg
      while [ $# -gt 0 ]; do
        case "$1" in
          --name) name=${2:-}; shift 2 ;;
          --deliver) deliver=${2:-}; shift 2 ;;
          --script) script=${2:-}; shift 2 ;;
          --skill) skills=$((skills + 1)); shift 2 ;;
          --failure-deliver|--repeat|--monitor-script|--monitor-url|--workdir|--model|--provider|--reasoning-effort|--interpreter|--paused-reason) shift 2 ;;
          --no-agent) noagent=1; shift ;;
          --paused) paused=1; shift ;;
          --pin|--continuity) shift ;;
          --) shift ;;
          *) if [ -z "$schedule" ]; then schedule=$1; else prompt=$1; havep=1; fi; shift ;;
        esac
      done
      event cron create; inject cron.create
      local err=""
      if [ "$noagent" = 1 ] && [ -z "$script" ]; then err="create with no_agent=True requires a script — the script is the job."
      elif [ "$noagent" = 0 ] && [ "$havep" = 0 ] && [ "$skills" = 0 ]; then err="create requires either prompt or at least one skill"
      fi
      if [ -z "$err" ] && [ "$havep" = 1 ]; then
        arg=$(cron_prompt_threat "$prompt") && err="Blocked: prompt matches threat pattern '$arg'. Cron prompts must not contain injection or exfiltration payloads."
      fi
      if [ -z "$err" ] && [ -n "$script" ]; then
        case "$script" in
          /*|~*) err="Script path must be relative to $H/scripts/. Got absolute or home-relative path: '$script'. Place scripts in $H/scripts/ and use just the filename." ;;
          *..*) err="Script path escapes the scripts directory via traversal: '$script'" ;;
          *) [ -f "$H/scripts/$script" ] || err="Script file not found: $H/scripts/$script. Create it in $H/scripts/ first." ;;
        esac
      fi
      local display=""
      if [ -z "$err" ]; then display=$(cron_parse_schedule "$schedule") || err=$display; fi
      if [ -z "$err" ]; then
        local scan=$prompt
        [ -n "$script" ] && scan="$prompt
$(cat "$H/scripts/$script")"
        cron_guard_hit "$scan" && err="Blocked: cron job contains a gateway lifecycle command or persistent launchctl submit operation. This is blocked to prevent agent-driven SIGTERM-respawn loops under launchd/systemd supervision (#30719). Run \`hermes gateway restart\` from a shell outside the running gateway instead."
      fi
      if [ -n "$err" ]; then printf 'Failed to create job: %s\n' "$err"; return 1; fi
      local n=0 id
      [ -f "$HOME/state/cron.count" ] && n=$(cat "$HOME/state/cron.count")
      n=$((n + 1)); echo "$n" > "$HOME/state/cron.count"
      id=$(printf 'c0ffee%06x' "$n")
      [ -n "$name" ] || { name=$(printf '%s' "${prompt:-${script:-cron job}}" | cut -c1-50 | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'); }
      mkdir -p "$J/$id"
      printf '%s' "$name" > "$J/$id/name"; printf '%s' "$display" > "$J/$id/schedule"; printf '%s' "${deliver:-local}" > "$J/$id/deliver"
      printf '%s' "$script" > "$J/$id/script"; printf '%s' "$noagent" > "$J/$id/no_agent"; printf '%s' "$prompt" > "$J/$id/prompt"
      printf '%s' "$([ "$paused" = 1 ] && echo paused || echo active)" > "$J/$id/state"
      printf 'Created job: %s\n  Name: %s\n  Schedule: %s\n' "$id" "$name" "$display"
      [ -n "$script" ] && printf '  Script: %s\n' "$script"
      [ "$noagent" = 1 ] && printf '  Mode: no-agent (script stdout delivered directly)\n'
      if [ "$paused" = 1 ]; then echo "  Created PAUSED — resume to schedule, or explicitly run now."; else echo "  Next run: 2026-10-26T09:00:00+00:00"; fi
      cron_warn_sched ;;
    list)
      event cron list
      [ -f "$HOME/knobs/cron_list_fail" ] && { echo "hermes: injected failure (cron list)" >&2; return 1; }
      if [ -f "$HOME/knobs/cron_list_hide" ]; then echo "No scheduled jobs in profile 'default'."; return 0; fi
      local all=0 d any=0 st bar
      [ "${1:-}" = "--all" ] && all=1
      for d in "$J"/*; do
        [ -d "$d" ] || continue
        st=$(cat "$d/state")
        [ "$all" = 0 ] && [ "$st" != active ] && [ "$st" != paused ] && continue
        if [ "$any" = 0 ]; then
          any=1
          bar=$(printf '%73s' '' | sed 's/ /─/g')
          printf '\n┌%s┐\n│%25s%-48s│\n└%s┘\n\n' "$bar" "" "Scheduled Jobs (profile: default)" "$bar"
        fi
        printf '  %s [%s]\n' "$(basename "$d")" "$st"
        printf '    %-11s%s\n' "Name:" "$(cat "$d/name")" "Schedule:" "$(cat "$d/schedule")" "Repeat:" "∞" "Next run:" "2026-10-26T09:00:00+00:00" "Deliver:" "$(cat "$d/deliver")"
        [ -s "$d/script" ] && printf '    %-11s%s\n' "Script:" "$(cat "$d/script")"
        [ "$(cat "$d/no_agent")" = 1 ] && printf '    %-11s%s\n' "Mode:" "no-agent (script stdout delivered directly)"
        echo
      done
      if [ "$any" = 0 ]; then
        echo "No scheduled jobs in profile 'default'."
        echo "Create one with 'hermes cron create ...' or the /cron command in chat."
        return 0
      fi
      cron_warn_sched ;;
    remove|rm|delete)
      event cron remove
      local d
      d=$(cron_find "${1:-}") || { printf "Failed to remove job: Job with ID or name '%s' not found. Use cronjob(action='list') to inspect jobs.\n" "${1:-}"; return 1; }
      printf 'Removed job: %s (%s)\n' "$(cat "$d/name")" "$(basename "$d")"
      rm -rf "$d" ;;
    pause|resume)
      event cron "$sub"
      local d
      d=$(cron_find "${1:-}") || { printf "Failed to %s job: Job with ID or name '%s' not found.\n" "$sub" "${1:-}"; return 1; }
      printf '%s' "$([ "$sub" = pause ] && echo paused || echo active)" > "$d/state"
      printf '%s job: %s (%s)\n' "$([ "$sub" = pause ] && echo Paused || echo Resumed)" "$(cat "$d/name")" "$(basename "$d")" ;;
    run)
      event cron run
      local d rc
      d=$(cron_find "${1:-}") || { printf "Failed to run job: Job with ID or name '%s' not found. Use cronjob(action='list') to inspect jobs.\n" "${1:-}"; return 1; }
      printf 'Triggered job: %s (%s)\n' "$(cat "$d/name")" "$(basename "$d")"
      printf '%s run\n' "$(basename "$d")" >> "$HOME/logs/cron-runs.log"
      if [ "$(cat "$d/no_agent")" = 1 ]; then
        (cd "$H/scripts" && bash "$(cat "$d/script")" > /dev/null 2>&1); rc=$?
        printf '%s rc=%s\n' "$(basename "$d")" "$rc" >> "$HOME/logs/cron-runs.log"
        if [ "$rc" = 0 ]; then echo "  Ran now: succeeded."; else echo "  Ran now: failed."; return 1; fi
      else
        echo "  It will run on the next scheduler tick."
      fi ;;
    status)
      event cron status
      if [ "$(cat "$H/gateway.state" 2>/dev/null || echo stopped)" = running ]; then echo "✓ Gateway is running — cron jobs will fire"; else echo "✗ No scheduler is serving profile 'default' — its cron jobs will NOT fire"; fi ;;
    doctor)
      event cron doctor
      local d bad=0 n=0 s
      for d in "$J"/*; do
        [ -d "$d" ] || continue
        [ "$(cat "$d/state")" = active ] || continue
        n=$((n + 1)); s=$(cat "$d/script")
        if [ -n "$s" ] && [ ! -f "$H/scripts/$s" ]; then
          [ "$bad" = 0 ] && echo "Cron doctor found issue(s):"
          bad=1; printf '  %s %s\n    - script not found: %s\n' "$(basename "$d")" "$(cat "$d/name")" "$H/scripts/$s"
        fi
      done
      if [ "$bad" = 0 ]; then echo "✓ Cron doctor found no issues"; echo "  Checked $n active job(s)."; return 0; fi
      return 1 ;;
    *) event unknown cron "$sub" "$@"; echo "hermes: unknown: cron $sub $*" >&2; return 99 ;;
  esac
}
