#!/bin/bash
# Test behaviour of `hermes send --to TARGET MESSAGE` and `hermes send --list [PLATFORM]` (hermes_cli/send_cmd.py at v0.22.5). Sourced by the
# hermes stub; $@ starts at the command (-p already removed). The SYNTAX is checked by the real vendored argparse before this runs; the
# BEHAVIOUR below is an assumption written from the source's output strings: success prints the tool's note (or "sent") and exits 0
# (send_cmd.py:73-81), a delivery error prints "hermes send: <error>" on stderr and exits 1 (send_cmd.py:73-74,81). The event log records
# the TARGET only (never the message); the message is visible in logs/hermes-argv.log like every argv.
#
# Home channel: a BARE platform name addresses the home channel (send_cmd.py:245-249, tools/send_message_tool.py:242-245,401-413). The stub
# resolves it from the platform's cron_deliver_env_var in ~/.hermes/.env (TELEGRAM_HOME_CHANNEL ..., MATRIX_HOME_ROOM for matrix;
# plugins/platforms/*/adapter.py `cron_deliver_env_var=`), else from a flat `platforms.<p>.home_channel` line of config.yaml. Success prints
# "Sent to <p> home channel (chat_id: <id>)" (send_message_tool.py:284-285); none set prints "No home channel set for <p> to determine where to
# send the message. Either specify a channel directly with '<p>:CHANNEL_NAME', or set a home channel via: hermes config set <VAR> <channel_id>"
# on stderr, exit 1 (send_message_tool.py:411-413, send_cmd.py:73-74). An explicit target prints "sent". Every resolved send is appended to
# logs/send-resolved.log as "<platform>\t<chat_id>\t<message>".
#
# `--list PLATFORM` (send_cmd.py:84-115): exit 0 and "<platform>:" + its channels when the platform is connected, else
# "hermes send: no targets found for platform 'X'. Configured: a, b" on stderr and exit 1. The stub treats a platform as connected when it is a
# line of $HOME/send.platforms or ~/.hermes/.env holds a credential-shaped key of that platform (<PLATFORM>_...TOKEN / _URL / _ENABLED /
# _CLIENT_ID / _HOMESERVER). Event: "hermes send-list <platform>".
#
# Knobs: fail.send -> delivery error (exit 1); fail.send-list -> --list fails; send_other_id (file with an id) -> another source wins and the send resolves that chat.
# shellcheck disable=SC2154  # event and inject are defined by the sourcing hermes stub
send_home_var() { # platform -> env var name of its home channel
  case "$1" in
    matrix) echo MATRIX_HOME_ROOM ;;
    google_chat) echo GOOGLE_CHAT_HOME_CHANNEL ;;
    *) printf '%s_HOME_CHANNEL\n' "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')" ;;
  esac
}
send_platform_connected() { # lower-case platform
  local up
  up=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')
  if [ -f "$HOME/send.platforms" ] && grep -qxF -- "$1" "$HOME/send.platforms"; then return 0; fi
  grep -Eq "^${up}_[A-Z_]*(TOKEN|URL|ENABLED|CLIENT_ID|HOMESERVER)=" "$HOME/.hermes/.env" 2>/dev/null
}
hermes_cmd() {
  local target="" msg="" list=0 plat q var chat
  shift # drop "send"
  while [ $# -gt 0 ]; do
    case "$1" in
      -t|--to) target=${2:-}; shift 2 ;;
      --to=*) target=${1#--to=}; shift ;;
      -f|--file|-s|--subject|--mention) shift 2 ;;
      -l|--list) list=1; shift ;;
      -q|--quiet|--json) shift ;;
      *) msg=$1; shift ;;
    esac
  done
  if [ "$list" = 1 ]; then
    plat=$(printf '%s' "$msg" | tr '[:upper:]' '[:lower:]')
    event send-list "$plat"
    inject send-list
    if [ -z "$plat" ] || send_platform_connected "$plat"; then
      if [ -n "$plat" ]; then echo "$plat:"; echo "  (no channels discovered yet)"; fi
      return 0
    fi
    echo "hermes send: no targets found for platform '$msg'. Configured: $(for q in telegram discord slack mattermost matrix signal whatsapp teams google_chat; do send_platform_connected "$q" && printf '%s ' "$q"; done)" >&2
    return 1
  fi
  event send "$target"
  inject send
  case "$target" in
    *:*)
      printf '%s\t%s\t%s\n' "${target%%:*}" "${target#*:}" "$msg" >> "$HOME/logs/send-resolved.log"
      echo "sent" ;;
    *)
      var=$(send_home_var "$target")
      chat=$(sed -n "s/^$var=//p" "$HOME/.hermes/.env" 2>/dev/null | tail -n1 | sed 's/^"//; s/"$//')
      [ -n "$chat" ] || chat=$(sed -n "s/^platforms\.$target\.home_channel: //p" "$HOME/.hermes/config.yaml" 2>/dev/null | tail -n1)
      if [ -z "$chat" ]; then
        echo "hermes send: No home channel set for $target to determine where to send the message. Either specify a channel directly with '$target:CHANNEL_NAME', or set a home channel via: hermes config set $var <channel_id>" >&2
        return 1
      fi
      if [ -f "$HOME/knobs/send_other_id" ]; then chat=$(cat "$HOME/knobs/send_other_id"); fi
      printf '%s\t%s\t%s\n' "$target" "$chat" "$msg" >> "$HOME/logs/send-resolved.log"
      echo "Sent to $target home channel (chat_id: $chat)" ;;
  esac
}
