#!/bin/sh
# hstack check: the probe that runs where Hermes lives.
#
# STATUS: DRAFT. Not yet run against a real Hermes server. The CLI that will ship this
# file to a target (bin/hstack) and its tests are not written yet.
#
# The plan is to run this file on the target (your laptop, a VPS over SSH, or the Hermes
# container via docker exec) and read what it prints. It is plain POSIX sh so it runs on
# dash, bash, ash and busybox without installing anything. Run it directly for now:
#   sh lib/check.sh [--scope all|host|hermes]
#
# Read-only by design: it never writes a file, never restarts anything, and never passes
# --fix to `hermes doctor`. The only commands it runs:
#   hermes --version | gateway status | doctor | config path
#   df, stat, /proc/meminfo, journalctl -k (or dmesg), ufw status, firewall-cmd --state,
#   nft list ruleset, iptables -S INPUT, ss -ltn, sshd -T, dpkg-query, apt-config dump
#
# Output: one line per check, four tab-separated fields:
#   STATUS <TAB> ID <TAB> MESSAGE <TAB> FIX
# STATUS is PASS, WARN, FAIL or SKIP. FIX may be empty; MESSAGE never is.
#
# Written against Hermes v0.21.5 (tag v2026.9.24). Every piece of Hermes output matched
# below is quoted from that release's source, and the comment above each match names the
# source file it came from.

TESTED_MAJOR=0
TESTED_MINOR=21
QUICK_TIMEOUT=30
DOCTOR_TIMEOUT=180
BACKUP_MAX_AGE_DAYS=7

ESC=$(printf '\033')

# --- output ---------------------------------------------------------------------------

# One field on one line: no tabs, newlines, colour codes or other control characters.
clean() {
  printf '%s' "$1" | tr '\t\r\n' '   ' |
    sed -e "s/${ESC}\[[0-9;]*[A-Za-z]//g" -e 's/  *$//' |
    tr -d '\000-\010\013\014\016-\037'
}

emit() {
  em_msg=$(clean "$3")
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "${em_msg:--}" "$(clean "${4:-}")"
}

# --- environment helpers --------------------------------------------------------------

have_root() {
  [ "$(id -u)" = 0 ] && return 0
  command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1
}

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi
}

sudo_prefix() {
  if [ "$(id -u)" = 0 ]; then printf ''; else printf 'sudo '; fi
}

# Docker creates /.dockerenv and Podman creates /run/.containerenv inside every container.
in_container() {
  [ -f /.dockerenv ] || [ -f /run/.containerenv ]
}

is_linux() {
  [ "$(uname -s)" = Linux ]
}

is_debian_family() {
  [ -f /etc/debian_version ]
}

# `timeout` is coreutils/busybox; macOS has none, so run unbounded there.
run_limited() {
  rl_secs=$1
  shift
  if command -v timeout >/dev/null 2>&1; then timeout "$rl_secs" "$@"; else "$@"; fi
}

file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

# --- Hermes checks ----------------------------------------------------------------------

# Non-interactive SSH sessions often lack ~/.local/bin on PATH, so look there explicitly.
# That is where the official installer puts the `hermes` command (scripts/install.sh).
find_hermes() {
  HERMES_BIN=
  for fh_cand in "$(command -v hermes 2>/dev/null)" "$HOME/.local/bin/hermes" \
    "${HERMES_HOME:-$HOME/.hermes}/bin/hermes" /usr/local/bin/hermes; do
    if [ -n "$fh_cand" ] && [ -x "$fh_cand" ]; then
      HERMES_BIN=$fh_cand
      return 0
    fi
  done
  return 1
}

hermes_run() {
  hr_secs=$1
  shift
  run_limited "$hr_secs" "$HERMES_BIN" "$@" </dev/null 2>&1
}

# `hermes --version` prints "Hermes Agent v0.21.5 (2026.9.24)" on its first line
# (hermes_cli/_startup_fast.py, print_fast_version_info). Returns "0.21.5".
parse_version() {
  printf '%s\n' "$1" | awk '{
    for (i = 1; i <= NF; i++)
      if (match($i, /^v[0-9]+\.[0-9]+\.[0-9]+/)) { print substr($i, 2, RLENGTH - 1); exit }
  }'
}

# Same function prints "Update available ..." or "Up to date" after the version details.
update_note() {
  case $1 in
    *"Update available"*) printf ' (Hermes says an update is available)' ;;
    *"Up to date"*) printf ' (up to date)' ;;
  esac
}

# Sets VERSION_STATE: ok, newer, old or unknown.
judge_version() {
  jv=$1
  if [ -z "$jv" ]; then
    VERSION_STATE=unknown
    emit WARN hermes.version "couldn't read the Hermes version" "run: hermes --version"
    return
  fi
  jv_major=${jv%%.*}
  jv_rest=${jv#*.}
  jv_minor=${jv_rest%%.*}
  if [ "$jv_major" -eq "$TESTED_MAJOR" ] && [ "$jv_minor" -lt "$TESTED_MINOR" ]; then
    VERSION_STATE=old
    emit FAIL hermes.version "Hermes $jv is older than $TESTED_MAJOR.$TESTED_MINOR: hstack only supports $TESTED_MAJOR.$TESTED_MINOR.x" \
      "hermes update"
  elif [ "$jv_major" -eq "$TESTED_MAJOR" ] && [ "$jv_minor" -eq "$TESTED_MINOR" ]; then
    VERSION_STATE=ok
    emit PASS hermes.version "Hermes $jv$2"
  else
    VERSION_STATE=newer
    emit WARN hermes.version "Hermes $jv is newer than hstack has tested ($TESTED_MAJOR.$TESTED_MINOR.x), so checks that read Hermes output may be wrong$2" \
      "look for an hstack update"
  fi
}

# `hermes gateway status` always exits 0, so we read its text. Strings quoted from
# hermes_cli/gateway.py (_cmd_status, systemd_status, _print_service_not_installed).
# $2 is 1 when we are inside a container, where Docker's restart policy replaces a service.
judge_gateway() {
  case $1 in
    *"Gateway is not running"* | *"gateway service is stopped"* | *"Gateway service is not installed"*)
      emit FAIL hermes.gateway "gateway is not running: your agent can't receive messages" \
        "start it: hermes gateway start (never installed as a service? $(sudo_prefix)${HERMES_BIN:-hermes} gateway install --system)"
      ;;
    *"Running manually, not as a system service"*)
      if [ "$2" = 1 ]; then
        emit PASS hermes.gateway "gateway is running inside the container (make sure the container has a restart policy)"
      else
        emit WARN hermes.gateway "gateway is running, but not as a service: it will not come back after a reboot" \
          "$(sudo_prefix)${HERMES_BIN:-hermes} gateway install --system"
      fi
      ;;
    *"linger is disabled"*)
      emit WARN hermes.gateway "gateway is a user service with linger off: it stops when you log out" \
        "sudo loginctl enable-linger $(id -un)"
      ;;
    *"gateway service is running"* | *"Gateway is running"*)
      emit PASS hermes.gateway "gateway is running"
      ;;
    *)
      emit WARN hermes.gateway "couldn't understand the output of hermes gateway status" "run: hermes gateway status"
      ;;
  esac
}

# `hermes doctor` exits 0 when clean and 1 when it found issues (hermes_cli/doctor.py:
# run_doctor returns int(bool(issues)); main.py turns that into the exit code). A crash
# also exits 1, so we tell the two apart by its summary line "Found N issue(s) to address:".
judge_doctor() {
  jd_rc=$1
  jd_out=$2
  if [ "$jd_rc" -eq 0 ]; then
    emit PASS hermes.doctor "hermes doctor: all checks passed"
    return
  fi
  if [ "$jd_rc" -eq 124 ]; then
    emit WARN hermes.doctor "hermes doctor did not finish within ${DOCTOR_TIMEOUT}s" "run it by hand: hermes doctor"
    return
  fi
  jd_count=$(printf '%s\n' "$jd_out" | sed -n 's/.*Found \([0-9][0-9]*\) issue.*/\1/p' | head -n 1)
  if [ -z "$jd_count" ]; then
    emit WARN hermes.doctor "hermes doctor exited with code $jd_rc and printed no summary (it may have crashed)" \
      "run it by hand to see the error: hermes doctor"
    return
  fi
  jd_list=$(printf '%s\n' "$jd_out" | sed "s/${ESC}\[[0-9;]*[A-Za-z]//g" | awk '
    /Found [0-9]+ issue/ { found = 1; next }
    found && /^ *[0-9]+\. / { sub(/^ *[0-9]+\. /, ""); n++; if (n <= 3) s = (s == "" ? $0 : s "; " $0) }
    END { if (n > 3) s = s " (+" n - 3 " more)"; print s }')
  emit WARN hermes.doctor "hermes doctor found $jd_count issue(s): $jd_list" \
    "see details: hermes doctor (it can repair some itself: hermes doctor --fix)"
}

# $1 kind ("full backup", "quick snapshot" or empty), $2 age in days, $3 HERMES_HOME
judge_backup() {
  if [ -z "$1" ]; then
    emit WARN hermes.backup "no Hermes backups found (looked for ~/hermes-backup-*.zip and $3/state-snapshots/)" \
      "hermes backup"
  elif [ "$2" -le "$BACKUP_MAX_AGE_DAYS" ]; then
    emit PASS hermes.backup "newest backup is a $1, $2 day(s) old (stored on this server, not off-site)"
  else
    emit WARN hermes.backup "newest backup is a $1, $2 days old" "hermes backup"
  fi
}

hermes_home() {
  hh_path=$(hermes_run "$QUICK_TIMEOUT" config path | tail -n 1)
  case $hh_path in
    /*config.yaml) dirname "$hh_path" ;;
    *) printf '%s\n' "${HERMES_HOME:-$HOME/.hermes}" ;;
  esac
}

# Full backups default to ~/hermes-backup-<timestamp>.zip; quick snapshots (also taken
# before every `hermes update`) go to $HERMES_HOME/state-snapshots/ (hermes_cli/backup.py).
check_backup() {
  cb_home=$(hermes_home)
  cb_kind=
  cb_newest=0
  for cb_f in "$HOME"/hermes-backup-*.zip; do
    [ -e "$cb_f" ] || continue
    cb_m=$(file_mtime "$cb_f") || continue
    if [ "$cb_m" -gt "$cb_newest" ]; then cb_newest=$cb_m cb_kind="full backup"; fi
  done
  for cb_f in "$cb_home"/state-snapshots/*; do
    [ -e "$cb_f" ] || continue
    cb_m=$(file_mtime "$cb_f") || continue
    if [ "$cb_m" -gt "$cb_newest" ]; then cb_newest=$cb_m cb_kind="quick snapshot"; fi
  done
  cb_age=0
  [ -n "$cb_kind" ] && cb_age=$((($(date +%s) - cb_newest) / 86400))
  judge_backup "$cb_kind" "$cb_age" "$cb_home"
}

check_hermes() {
  if ! find_hermes; then
    emit FAIL hermes.installed "Hermes not found for user $(id -un) (looked on PATH and in ~/.local/bin)" \
      "install it: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash (or connect as the user that runs Hermes)"
    for ch_id in hermes.version hermes.gateway hermes.doctor hermes.backup; do
      emit SKIP "$ch_id" "needs Hermes"
    done
    return
  fi
  emit PASS hermes.installed "found $HERMES_BIN"

  ch_ver=$(hermes_run "$QUICK_TIMEOUT" --version)
  judge_version "$(parse_version "$ch_ver")" "$(update_note "$ch_ver")"

  if [ "$VERSION_STATE" = old ]; then
    emit SKIP hermes.gateway "update Hermes first: this check reads $TESTED_MAJOR.$TESTED_MINOR output"
    emit SKIP hermes.doctor "update Hermes first: this check reads $TESTED_MAJOR.$TESTED_MINOR output"
  else
    ch_in_container=0
    in_container && ch_in_container=1
    judge_gateway "$(hermes_run "$QUICK_TIMEOUT" gateway status)" "$ch_in_container"
    ch_doc=$(hermes_run "$DOCTOR_TIMEOUT" doctor)
    judge_doctor "$?" "$ch_doc"
  fi
  check_backup
}

# --- host checks ----------------------------------------------------------------------

judge_container() {
  if [ "$1" = 1 ]; then
    emit WARN host.container "this is a container, not the server: the host results describe the container" \
      "point hstack at the server itself, and use --container for the Hermes container"
  else
    emit PASS host.container "running on the host, not inside a container"
  fi
}

# $1 percent used, $2 mount point
judge_disk() {
  if [ "$1" -ge 90 ]; then
    emit FAIL host.disk "disk $2 is $1% full" \
      "free space now: old journal logs (journalctl --vacuum-size=200M), unused Docker images (docker image prune), old backups"
  elif [ "$1" -ge 80 ]; then
    emit WARN host.disk "disk $2 is $1% full" "free some space before it fills up"
  else
    emit PASS host.disk "disk $2 is $1% full"
  fi
}

check_disk() {
  cd_path=$(hermes_home_or_root)
  cd_line=$(df -P "$cd_path" 2>/dev/null | awk 'NR == 2 { sub(/%/, "", $5); print $5, $6 }')
  if [ -z "$cd_line" ]; then
    emit SKIP host.disk "couldn't read disk usage (df failed)"
    return
  fi
  # shellcheck disable=SC2086 # split "percent mountpoint" into two arguments on purpose
  judge_disk $cd_line
}

hermes_home_or_root() {
  hr_home=${HERMES_HOME:-$HOME/.hermes}
  if [ -d "$hr_home" ]; then printf '%s\n' "$hr_home"; else printf '/\n'; fi
}

# Thresholds come from Hermes's own docs (website/docs/user-guide/docker.md): 1 GB minimum,
# 2-4 GB recommended, 2 GB+ with browser tools. A "1 GB" server reports roughly 950 MB and
# a "2 GB" one roughly 1900 MB, hence 900 and 1800 as the cut-offs.
# $1 MemTotal kB, $2 MemAvailable kB
judge_memory() {
  jm_total=$(($1 / 1024))
  jm_avail=$(($2 / 1024))
  if [ "$jm_total" -lt 900 ]; then
    emit FAIL host.memory "$jm_total MB RAM: below Hermes's documented minimum of 1 GB" "move to a server with at least 2 GB"
  elif [ $((jm_avail * 100)) -lt $((jm_total * 10)) ]; then
    emit WARN host.memory "only $jm_avail MB of $jm_total MB RAM free right now" \
      "see what is using it: ps aux --sort=-rss | head"
  elif [ "$jm_total" -lt 1800 ]; then
    emit WARN host.memory "$jm_total MB RAM: enough without browser tools, but Hermes recommends 2-4 GB" \
      "move to 2 GB+ if you use browser tools"
  else
    emit PASS host.memory "$jm_total MB RAM, $jm_avail MB free"
  fi
}

# $1 SwapTotal kB, $2 MemTotal kB
judge_swap() {
  js_swap=$(($1 / 1024))
  js_total=$(($2 / 1024))
  if [ "$js_swap" -gt 0 ]; then
    emit PASS host.swap "$js_swap MB swap"
  elif [ "$js_total" -ge 3800 ]; then
    emit PASS host.swap "no swap, which is ok with $js_total MB RAM"
  else
    emit WARN host.swap "no swap: when RAM runs out the kernel kills a process, often Hermes itself" \
      "add a 2 GB swap file: fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile, then add '/swapfile none swap sw 0 0' to /etc/fstab"
  fi
}

meminfo() {
  awk -v k="$1:" '$1 == k { print $2 }' /proc/meminfo 2>/dev/null
}

check_memory() {
  if ! is_linux || [ ! -r /proc/meminfo ]; then
    emit SKIP host.memory "only checked on Linux so far"
    emit SKIP host.swap "only checked on Linux so far"
    return
  fi
  cm_total=$(meminfo MemTotal)
  cm_avail=$(meminfo MemAvailable)
  cm_swap=$(meminfo SwapTotal)
  judge_memory "${cm_total:-0}" "${cm_avail:-0}"
  judge_swap "${cm_swap:-0}" "${cm_total:-0}"
}

# Kernel lines look like "Out of memory: Killed process 1234 (python3) ..." (older kernels:
# "Kill process"); cgroup kills say "Memory cgroup out of memory: Killed process ...".
count_oom() {
  printf '%s\n' "$1" | grep -ci 'out of memory: kill'
}

# $1 count, $2 time window in words
judge_oom() {
  if [ "$1" -eq 0 ]; then
    emit PASS host.oom "no out-of-memory kills $2"
  else
    emit WARN host.oom "$1 out-of-memory kill(s) $2" \
      "add swap or RAM; see which process died: journalctl -k | grep -i 'killed process'"
  fi
}

check_oom() {
  if ! is_linux; then
    emit SKIP host.oom "only checked on Linux so far"
  elif in_container; then
    emit SKIP host.oom "inside a container: kernel logs belong to the host"
  elif ! have_root; then
    emit SKIP host.oom "needs root (or passwordless sudo) to read kernel logs"
  elif command -v journalctl >/dev/null 2>&1; then
    judge_oom "$(count_oom "$(as_root journalctl -k --since=-7d --no-pager -q 2>/dev/null)")" "in the last 7 days"
  else
    judge_oom "$(count_oom "$(as_root dmesg 2>/dev/null)")" "since the last boot"
  fi
}

# An nftables chain counts as a firewall only if it hooks input AND drops by default or
# holds rules. An empty input chain (Docker's iptables-nft setup creates one) does not.
nft_has_input_rules() {
  printf '%s\n' "$1" | awk '
    /hook input/ { inchain = 1; if ($0 ~ /policy drop/) found = 1; next }
    inchain && /^[[:space:]]*}/ { inchain = 0; next }
    inchain && NF > 0 { found = 1 }
    END { exit found ? 0 : 1 }'
}

detect_firewall() {
  if command -v ufw >/dev/null 2>&1 && as_root ufw status 2>/dev/null | grep -q '^Status: active'; then
    echo ufw
  elif command -v firewall-cmd >/dev/null 2>&1 && [ "$(as_root firewall-cmd --state 2>/dev/null)" = running ]; then
    echo firewalld
  elif command -v nft >/dev/null 2>&1 && nft_has_input_rules "$(as_root nft list ruleset 2>/dev/null)"; then
    echo nftables
  elif command -v iptables >/dev/null 2>&1 && as_root iptables -S INPUT 2>/dev/null | grep -qE '^-P INPUT (DROP|REJECT)|^-A INPUT'; then
    echo iptables
  fi
}

judge_firewall() {
  if [ -n "$1" ]; then
    emit PASS host.firewall "$1 firewall is on"
  else
    emit WARN host.firewall "no firewall rules found on this server" \
      "allow SSH first, then switch it on: ufw allow OpenSSH && ufw enable (a firewall at your cloud provider also counts, but hstack can't see it)"
  fi
}

check_firewall() {
  if ! is_linux; then
    emit SKIP host.firewall "only checked on Linux so far"
  elif in_container; then
    emit SKIP host.firewall "inside a container: the firewall belongs to the host"
  elif ! have_root; then
    emit SKIP host.firewall "needs root (or passwordless sudo) to read firewall rules"
  else
    judge_firewall "$(detect_firewall)"
  fi
}

# Reads `ss -ltn` output. Prints the listening ports that are not loopback-only, skipping
# SSH (22), as "5432, 8642, 9119".
parse_listeners() {
  printf '%s\n' "$1" | awk '
    $1 != "LISTEN" { next }
    {
      addr = $4; n = split(addr, part, ":"); port = part[n]
      host = substr(addr, 1, length(addr) - length(port) - 1)
      if (host ~ /^127\./ || host ~ /^\[?::1\]?$/ || host ~ /^\[::ffff:127\./ || host ~ /%lo$/) next
      if (port == 22 || port in seen) next
      seen[port] = 1; print port
    }' | sort -n | awk '{ s = (NR == 1 ? $0 : s ", " $0) } END { print s }'
}

judge_ports() {
  if [ -z "$1" ]; then
    emit PASS host.ports "nothing but SSH listens on public interfaces"
    return
  fi
  jp_note=
  case ", $1," in *", 8642,"*) jp_note=" (8642 is the Hermes API server and health endpoint)" ;; esac
  emit WARN host.ports "listening on public interfaces: $1$jp_note. Your firewall must block any that shouldn't be public, and Docker-published ports bypass ufw" \
    "stop the service, bind it to 127.0.0.1, or block the port in the firewall"
}

check_ports() {
  if ! command -v ss >/dev/null 2>&1; then
    emit SKIP host.ports "ss is not installed (it ships with iproute2)"
  else
    judge_ports "$(parse_listeners "$(ss -ltn 2>/dev/null)")"
  fi
}

# Reads `sshd -T` output (the effective config, cloud-init drop-ins included).
judge_ssh() {
  js_pa=$(printf '%s\n' "$1" | awk '$1 == "passwordauthentication" { print $2 }')
  js_kbd=$(printf '%s\n' "$1" | awk '$1 == "kbdinteractiveauthentication" || $1 == "challengeresponseauthentication" { print $2; exit }')
  js_pam=$(printf '%s\n' "$1" | awk '$1 == "usepam" { print $2 }')
  js_root=$(printf '%s\n' "$1" | awk '$1 == "permitrootlogin" { print $2 }')
  js_status=PASS
  js_msg=
  js_fix=
  if [ "$js_pa" = yes ]; then
    js_status=FAIL
    js_msg="SSH accepts passwords, so bots can try to guess them"
    js_fix="set PasswordAuthentication no (also check /etc/ssh/sshd_config.d/, where cloud-init often turns it back on), then reload the SSH service. Keep this session open until a key login works"
  fi
  if [ "$js_kbd" = yes ] && [ "$js_pam" = yes ]; then
    [ "$js_status" = PASS ] && js_status=WARN
    js_msg="${js_msg:+$js_msg; }keyboard-interactive login is on, and with PAM it can still ask for a password"
    js_fix="${js_fix:+$js_fix; }set KbdInteractiveAuthentication no"
  fi
  if [ "$js_root" = yes ]; then
    [ "$js_status" = PASS ] && js_status=WARN
    js_msg="${js_msg:+$js_msg; }root can log in by any method"
    js_fix="${js_fix:+$js_fix; }set PermitRootLogin prohibit-password"
  fi
  if [ "$js_status" = PASS ]; then
    emit PASS host.ssh "SSH is key-only (password login is off)"
  else
    emit "$js_status" host.ssh "$js_msg" "$js_fix"
  fi
}

check_ssh() {
  if in_container; then
    emit SKIP host.ssh "inside a container: SSH belongs to the host"
  elif ! command -v sshd >/dev/null 2>&1; then
    emit SKIP host.ssh "no SSH server on this machine"
  elif ! have_root; then
    emit SKIP host.ssh "needs root (or passwordless sudo) to read the SSH server config"
  else
    cs_cfg=$(as_root sshd -T 2>/dev/null)
    if [ -z "$cs_cfg" ]; then
      emit WARN host.ssh "couldn't read the SSH server config (sshd -T failed)" "run: sudo sshd -T"
    else
      judge_ssh "$cs_cfg"
    fi
  fi
}

# $1 "yes" if unattended-upgrades is installed, $2 value of APT::Periodic::Unattended-Upgrade
judge_updates() {
  if [ "$1" != yes ]; then
    emit WARN host.updates "automatic security updates are off (unattended-upgrades is not installed)" \
      "apt install unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades"
  elif [ "$2" != 1 ]; then
    emit WARN host.updates "unattended-upgrades is installed but not switched on" "dpkg-reconfigure -plow unattended-upgrades"
  else
    emit PASS host.updates "automatic security updates are on"
  fi
}

check_updates() {
  if in_container; then
    emit SKIP host.updates "inside a container: the host handles OS updates"
  elif ! is_debian_family; then
    emit SKIP host.updates "only checked on Debian/Ubuntu so far"
  else
    cu_installed=no
    dpkg-query -W -f='${Status}' unattended-upgrades 2>/dev/null | grep -q 'install ok installed' && cu_installed=yes
    cu_enabled=$(apt-config dump 2>/dev/null | awk -F'"' '/^APT::Periodic::Unattended-Upgrade / { v = $2 } END { print v }')
    judge_updates "$cu_installed" "$cu_enabled"
  fi
}

check_reboot() {
  if in_container; then
    emit SKIP host.reboot "inside a container"
  elif ! is_debian_family; then
    emit SKIP host.reboot "only checked on Debian/Ubuntu so far"
  elif [ -f /var/run/reboot-required ]; then
    emit WARN host.reboot "a reboot is pending (usually for a kernel security update)" \
      "reboot when it suits you, then run hstack check again to confirm Hermes came back"
  else
    emit PASS host.reboot "no reboot pending"
  fi
}

check_host() {
  ch_c=0
  in_container && ch_c=1
  judge_container "$ch_c"
  check_disk
  check_memory
  check_oom
  check_firewall
  check_ports
  check_ssh
  check_updates
  check_reboot
}

# --- main -------------------------------------------------------------------------------

main() {
  m_scope=all
  while [ $# -gt 0 ]; do
    case $1 in
      --scope)
        [ $# -ge 2 ] || {
          echo "check.sh: --scope needs a value" >&2
          exit 64
        }
        m_scope=$2
        shift 2
        ;;
      --scope=*)
        m_scope=${1#--scope=}
        shift
        ;;
      *)
        echo "check.sh: unknown argument: $1" >&2
        exit 64
        ;;
    esac
  done
  case $m_scope in
    all | host | hermes) ;;
    *)
      echo "check.sh: --scope must be all, host or hermes" >&2
      exit 64
      ;;
  esac

  # Non-root SSH sessions often leave sbin off PATH, which hides sshd, ufw and friends.
  PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"
  NO_COLOR=1
  export PATH NO_COLOR

  [ "$m_scope" = host ] || check_hermes
  [ "$m_scope" = hermes ] || check_host
  exit 0
}

# Tests source this file with HSTACK_CHECK_LIB=1 to call the functions directly.
# stdin is /dev/null so no command can swallow the rest of this script when it is being
# piped in through `sh -s` (the ssh and docker exec paths).
if [ "${HSTACK_CHECK_LIB:-0}" != 1 ]; then
  main "$@" </dev/null
fi
