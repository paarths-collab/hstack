#!/usr/bin/env bash
# Regression tests for scripts/validate-skills.sh, metrics/update-clone-traffic.mjs and the
# GitHub workflow files.
#
#   bash tests/installer/test-scripts.sh          # any bash >= 3.2 (stock macOS /bin/bash works)
#
# Offline and self-contained: skill fixtures are generated into a throwaway repo, so the result
# does not depend on the state of the real skills/ catalogue or VERSIONS.txt. The metrics and
# workflow sections need node, ruby and git and are skipped (and reported) when one is missing.
# Prints a PASS/FAIL line per assertion and a summary; exits non-zero if anything failed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATE="$ROOT/scripts/validate-skills.sh"

# Never inherit the caller's CI / token / metrics settings.
unset TRAFFIC_TOKEN REPO GITHUB_REPOSITORY GITHUB_API_URL METRICS_DIR GITHUB_BASE_REF

TMP_BASE="$(mktemp -d "${TMPDIR:-/tmp}/hstack-scripts-test.XXXXXX")"
SRV_PID=""
cleanup() {
  if [ -n "$SRV_PID" ]; then kill "$SRV_PID" 2>/dev/null || true; fi
  rm -rf "$TMP_BASE"
}
trap cleanup EXIT

PASS=0
FAIL=0
RC=0
OUT=""
ERR=""

pass() {
  PASS=$((PASS + 1))
  printf 'PASS: %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL: %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
}
assert() {
  local desc="$1"
  shift
  if "$@"; then pass "$desc"; else fail "$desc"; fi
}
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected '$2', got '$3'"; fi
}
out_has() { case "$OUT" in *"$1"*) return 0 ;; esac; return 1; }
err_has() { case "$ERR" in *"$1"*) return 0 ;; esac; return 1; }
all_has() { case "$OUT$ERR" in *"$1"*) return 0 ;; esac; return 1; }

# run <cmd...>: stdout in OUT, stderr in ERR, status in RC (stdin closed)
run() {
  OUT="$("$@" 2>"$TMP_BASE/stderr" </dev/null)"
  RC=$?
  ERR="$(cat "$TMP_BASE/stderr")"
}

printf 'bash %s, repo %s\n\n' "${BASH_VERSION:-?}" "$ROOT"

# ===========================================================================
# validate-skills.sh on generated fixtures
# ===========================================================================
MARKER='> **Compatibility:** legacy procedure written for Hermes 0.15.x — not yet re-verified on Hermes 0.22.5. Commands such as `gateway run --daemon` in older copies do not exist on 0.22.5; prefer /hermes-restart for reloads.'
VR="$TMP_BASE/vrepo"
mkdir -p "$VR/scripts" "$VR/skills"
cp "$VALIDATE" "$VR/scripts/validate-skills.sh"
cat >"$VR/VERSIONS.txt" <<'EOF'
HERMES_VERSION=0.22.5
SKILL_MIN_LINE_COUNT=200
SKILL_MAX_LINE_COUNT=900
SKILL_MIN_PITFALLS=6
EOF
FV="$VR/scripts/validate-skills.sh"

# mkskill <name> [key=value ...]  keys: marker=1|fence|after-intro|after-h2, noname=1, nodesc=1,
#                                       intro="text", code="<bash line>" (inside a fenced block)
mkskill() {
  local name="$1" marker=0 noname=0 nodesc=0 intro="" code="" kv i
  shift
  for kv in "$@"; do
    case "$kv" in
      marker=*) marker="${kv#marker=}" ;;
      noname=*) noname="${kv#noname=}" ;;
      nodesc=*) nodesc="${kv#nodesc=}" ;;
      intro=*) intro="${kv#intro=}" ;;
      code=*) code="${kv#code=}" ;;
    esac
  done
  mkdir -p "$VR/skills/$name"
  {
    echo "---"
    if [ "$noname" != 1 ]; then echo "name: $name"; fi
    if [ "$nodesc" != 1 ]; then echo "description: A generated fixture skill whose description is long enough to pass"; fi
    echo "---"
    echo
    echo "# /$name - fixture"
    echo
    if [ "$marker" = 1 ]; then
      echo "$MARKER"
      echo
    fi
    if [ "$marker" = fence ]; then
      echo '```text'
      echo "$MARKER"
      echo '```'
      echo
    fi
    if [ -n "$intro" ]; then
      echo "$intro"
      echo
    fi
    if [ "$marker" = after-intro ]; then
      echo "$MARKER"
      echo
    fi
    echo "## Before you start - gather"
    echo
    for i in 1 2 3 4 5 6; do
      echo "## Step $i - something"
      echo
    done
    if [ -n "$code" ]; then
      echo '```bash'
      echo "$code"
      echo '```'
      echo
    fi
    echo "## Rollback"
    echo
    echo "## Pitfalls"
    echo
    for i in 1 2 3 4 5 6; do echo "| $i | problem | fix |"; done
    echo
    echo "## Definition of done"
    echo
    for i in 1 2 3 4 5 6; do echo "- [ ] thing $i"; done
    echo
    if [ "$marker" = after-h2 ]; then
      echo "$MARKER"
      echo
    fi
    echo "## Notes"
    echo
    if [ "$noname" = 1 ]; then echo "name: $name"; fi
    if [ "$nodesc" = 1 ]; then echo "description: A generated fixture skill whose description is long enough to pass"; fi
    for i in $(seq 1 200); do echo "padding line $i"; done
  } >"$VR/skills/$name/SKILL.md"
}
v() { run bash "$FV" --skill="$1"; }

mkskill fx-ok
v fx-ok
assert_eq "(validate) a clean generated fixture passes" 0 "$RC"

# --- D3: version pin / legacy marker -------------------------------------------------------
mkskill fx-old intro="Written for Hermes 0.15.2 only."
v fx-old
assert "(pin) a skill naming Hermes 0.15.2 without the pin or the marker fails" test "$RC" -eq 1
assert "(pin) ...and says it needs the marker" err_has "legacy-compatibility marker"

mkskill fx-old-marked intro="Written for Hermes 0.15.2 only." marker=1
v fx-old-marked
assert_eq "(pin) the same skill WITH the exact legacy marker line passes" 0 "$RC"

mkskill fx-pin-named intro="Targets Hermes 0.22.5; older copies used 0.15.2."
v fx-pin-named
assert_eq "(pin) a skill that names HERMES_VERSION (0.22.5) passes" 0 "$RC"

mkskill fx-other-0x intro="Works with Hermes 0.20.1."
v fx-other-0x
assert "(pin) a 0.2x.y mention that is not the pin fails too" test "$RC" -eq 1

mkskill fx-not-a-version intro="Python 3.10.12 and build 10.12.3 and 1.0.15.2 are not Hermes versions."
v fx-not-a-version
assert_eq "(pin) lookalike numbers (3.10.12, 10.12.3, 1.0.15.2) are not read as Hermes versions" 0 "$RC"

mkskill fx-daemon code='hermes gateway run --daemon'
v fx-daemon
assert "(pin) a skill WITHOUT the marker containing 'gateway run --daemon' fails" test "$RC" -eq 1
assert "(pin) ...and names the offending command" err_has "gateway run --daemon"

mkskill fx-daemon-flags code='hermes gateway run -v --daemon >/dev/null'
v fx-daemon-flags
assert "(pin) 'gateway run <flags> --daemon' is caught too" test "$RC" -eq 1

mkskill fx-daemon-cont code=$'hermes gateway run \\\n  --daemon'
v fx-daemon-cont
assert "(pin) 'gateway run \\' with --daemon on the next line is caught" test "$RC" -eq 1

mkskill fx-daemon-cont2 code=$'hermes gateway \\\n  run --daemon'
v fx-daemon-cont2
assert "(pin) 'gateway \\' with 'run --daemon' on the next line is caught" test "$RC" -eq 1

mkskill fx-daemon-profile code='hermes -p default gateway run --daemon'
v fx-daemon-profile
assert "(pin) 'hermes -p default gateway run --daemon' is caught" test "$RC" -eq 1

mkskill fx-daemon-redirect code='hermes gateway run 2>&1 --daemon'
v fx-daemon-redirect
assert "(pin) a redirect before --daemon does not hide it" test "$RC" -eq 1

mkskill fx-daemon-marked code='hermes gateway run --daemon' marker=1
v fx-daemon-marked
assert_eq "(pin) ...the same command in a marked legacy skill is allowed" 0 "$RC"

mkskill fx-marker-late intro="Hermes 0.15.2." marker=after-h2
v fx-marker-late
assert "(pin) the marker only counts under the H1 (before the first '## '), not later in the file" test "$RC" -eq 1

mkskill fx-marker-fence intro="Hermes 0.15.2." marker=fence
v fx-marker-fence
assert "(pin) the marker inside a code fence under the H1 does not count" test "$RC" -eq 1

mkskill fx-marker-notfirst intro="Hermes 0.15.2." marker=after-intro
v fx-marker-notfirst
assert "(pin) the marker must be the first non-blank line after the H1 (not after other prose)" test "$RC" -eq 1

mkskill fx-marker-edited intro="Hermes 0.15.2."
{ sed -n '1,6p' "$VR/skills/fx-marker-edited/SKILL.md"; echo "${MARKER%reloads.}reloads (edited)."; sed -n '7,$p' "$VR/skills/fx-marker-edited/SKILL.md"; } >"$TMP_BASE/edited.md"
mv "$TMP_BASE/edited.md" "$VR/skills/fx-marker-edited/SKILL.md"
v fx-marker-edited
assert "(pin) a reworded marker is not the marker" test "$RC" -eq 1

# --- 8a: .hermes/.env write forms need a chmod 600 --------------------------------------------
check_write() { # <label> <code line> (expects failure without chmod, pass with it)
  local label="$1" line="$2"
  mkskill fx-w code="$line"
  v fx-w
  assert "(secret) $label without chmod 600 fails" test "$RC" -eq 1
  assert "(secret) $label: the failure is the chmod rule" err_has "chmod 600"
  mkskill fx-w code="$line"$'\nchmod 600 ~/.hermes/.env'
  v fx-w
  assert_eq "(secret) $label with chmod 600 passes" 0 "$RC"
}
check_write 'hermes config set' 'hermes config set TELEGRAM_BOT_TOKEN "$v"'
check_write 'hermes -p default config set' 'hermes -p default config set TELEGRAM_BOT_TOKEN "$v"'
check_write 'hermes --profile default config set' 'hermes --profile default config set TELEGRAM_BOT_TOKEN "$v"'
check_write 'hermes --profile=default config set' 'hermes --profile=default config set TELEGRAM_BOT_TOKEN "$v"'
check_write '>> ~/.hermes/.env (control)' 'echo "K=v" >> ~/.hermes/.env'
check_write '>> "$HOME/.hermes/.env"' 'echo "K=v" >> "$HOME/.hermes/.env"'
check_write '>> ${HOME}/.hermes/.env' 'echo "K=v" >>${HOME}/.hermes/.env'
check_write '> /root/.hermes/.env' 'printf "K=v\n" > /root/.hermes/.env'
check_write "single-quoted >> '\$HOME/.hermes/.env'" "echo K=v >> '\$HOME/.hermes/.env'"
check_write '| tee -a ~/.hermes/.env' 'printf "K=v\n" | tee -a ~/.hermes/.env'
check_write '| tee "$HOME/.hermes/.env"' 'printf "K=v\n" | tee "$HOME/.hermes/.env" >/dev/null'
check_write 'sed -i on ~/.hermes/.env' "sed -i 's/^K=.*/K=v/' ~/.hermes/.env"
mkskill fx-r code='grep -c K ~/.hermes/.env'
v fx-r
assert_eq "(secret) reading ~/.hermes/.env needs no chmod" 0 "$RC"
mkskill fx-r2 code='cat ~/.hermes/.env > /tmp/copy.txt'
v fx-r2
assert_eq "(secret) redirecting the OUTPUT of a read is not a write to .env" 0 "$RC"
mkskill fx-r3 intro='Prose: echo K=v >> ~/.hermes/.env is what NOT to do.'
v fx-r3
assert_eq "(secret) a prose mention outside a code block is ignored" 0 "$RC"

# --- 8b: name / description are read from the frontmatter only -------------------------------
mkskill fx-b noname=1
v fx-b
assert "(frontmatter) a 'name:' line in the BODY does not satisfy the name check" test "$RC" -eq 1
assert "(frontmatter) ...the failure names the missing frontmatter name" err_has "frontmatter 'name:' missing"
mkskill fx-d nodesc=1
v fx-d
assert "(frontmatter) a 'description:' line in the BODY does not satisfy the description check" test "$RC" -eq 1
assert "(frontmatter) ...the failure names the missing frontmatter description" err_has "'description:' missing"

# --- 8c: --json is machine-readable on stdout even without --quiet ---------------------------
run bash "$FV" --skill=fx-ok --json
assert_eq "(json) --json without --quiet: exit 0 on a passing skill" 0 "$RC"
assert_eq "(json) --json without --quiet: stdout is exactly the JSON line" '{"total":1,"passed":1,"failed":0,"failures":[]}' "$OUT"
assert "(json) ...the progress went to stderr" err_has "Validating 1 skill(s)"
run bash "$FV" --skill=fx-old --json
assert_eq "(json) a failing skill: exit 1" 1 "$RC"
assert "(json) ...stdout is still one JSON object listing the failure" \
  test "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" = 1 -a "${OUT#\{\"total\":1,\"passed\":0,\"failed\":1,\"failures\":\[\"skills/fx-old/SKILL.md: }" != "$OUT"
case "$OUT" in *Validating* | *"✓"*) fail "(json) stdout carries no progress text" "$OUT" ;; *) pass "(json) stdout carries no progress text" ;; esac
if command -v python3 >/dev/null 2>&1; then
  if printf '%s' "$OUT" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then pass "(json) python parses it"; else fail "(json) python parses it" "$OUT"; fi
elif command -v node >/dev/null 2>&1; then
  if printf '%s' "$OUT" | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' 2>/dev/null; then pass "(json) node parses it"; else fail "(json) node parses it" "$OUT"; fi
else
  printf 'SKIP: (json) no python3/node to parse the JSON\n'
fi
run bash "$FV" --skill=fx-ok --json --quiet
assert_eq "(json) --json --quiet still works" '{"total":1,"passed":1,"failed":0,"failures":[]}' "$OUT"
run bash "$FV" --help
assert "(help) --help documents the legacy marker and the daemon rule" out_has "gateway run --daemon"

# the full run over the generated tree: one failing fixture is enough to fail the whole run
run bash "$FV" --quiet
assert "(validate) a tree containing failing fixtures exits 1" test "$RC" -eq 1

# ===========================================================================
# metrics/update-clone-traffic.mjs
# ===========================================================================
HAVE_NODE=0
command -v node >/dev/null 2>&1 && HAVE_NODE=1
if [ "$HAVE_NODE" = 1 ]; then
  MA="$TMP_BASE/mainckout/metrics"
  MD="$TMP_BASE/datadir"
  mkdir -p "$MA" "$MD"
  cp "$ROOT/metrics/update-clone-traffic.mjs" "$MA/"
  cat >"$MD/clone-traffic.json" <<'EOF'
{
  "repo": "owner/name",
  "note": "n",
  "days": { "2025-12-31": { "count": 1, "uniques": 1 } },
  "totals": { "days": 1, "clones": 1, "unique_cloners_approx": 1 },
  "updated": "2025-12-31T00:00:00.000Z"
}
EOF
  cp "$MD/clone-traffic.json" "$TMP_BASE/json.orig"

  # no token: a failure that writes nothing (it used to warn, exit 0 and bump "updated")
  run env METRICS_DIR="$MD" node "$MA/update-clone-traffic.mjs"
  assert "(metrics) no TRAFFIC_TOKEN: exits non-zero" test "$RC" -ne 0
  assert "(metrics) ...and says the token is missing" err_has "TRAFFIC_TOKEN"
  assert "(metrics) ...and rewrote nothing (history and 'updated' stamp intact)" cmp -s "$MD/clone-traffic.json" "$TMP_BASE/json.orig"
  assert "(metrics) ...and wrote no SVG" test ! -e "$MD/clone-traffic.svg"
  run env METRICS_DIR="$MD" node "$MA/update-clone-traffic.mjs" --no-fetch
  assert_eq "(metrics) --no-fetch needs no token" 0 "$RC"
  assert "(metrics) --no-fetch re-renders the SVG" test -s "$MD/clone-traffic.svg"
  assert "(metrics) --no-fetch leaves the JSON (and its 'updated' stamp) untouched" cmp -s "$MD/clone-traffic.json" "$TMP_BASE/json.orig"
  EXTRA=""
  for f in "$MA"/* "$MA"/.[!.]*; do
    if [ -e "$f" ] && [ "$(basename "$f")" != update-clone-traffic.mjs ]; then EXTRA="$EXTRA $f"; fi
  done
  assert "(metrics) METRICS_DIR keeps the script directory clean (extra:${EXTRA:- none})" test -z "$EXTRA"

  # a local stand-in for the GitHub API
  cat >"$TMP_BASE/mock.js" <<'EOF'
const http = require("http");
const fs = require("fs");
const [portFile, status, logFile] = process.argv.slice(2);
const srv = http.createServer((req, res) => {
  fs.appendFileSync(logFile, req.method + " " + req.url + " " + (req.headers.authorization || "") + "\n");
  res.writeHead(Number(status), { "content-type": "application/json" });
  res.end(JSON.stringify({ count: 7, uniques: 3, clones: [
    { timestamp: "2026-01-02T00:00:00Z", count: 5, uniques: 2 },
    { timestamp: "2026-01-03T00:00:00Z", count: 2, uniques: 1 } ] }));
});
srv.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(srv.address().port)));
EOF
  start_mock() { # <status>: sets MOCK_URL
    rm -f "$TMP_BASE/mock.port"
    : >"$TMP_BASE/mock.log"
    node "$TMP_BASE/mock.js" "$TMP_BASE/mock.port" "$1" "$TMP_BASE/mock.log" &
    SRV_PID=$!
    local n=0
    while [ ! -s "$TMP_BASE/mock.port" ] && [ "$n" -lt 100 ]; do
      sleep 0.1
      n=$((n + 1))
    done
    MOCK_URL="http://127.0.0.1:$(cat "$TMP_BASE/mock.port" 2>/dev/null)"
  }
  stop_mock() {
    if [ -n "$SRV_PID" ]; then kill "$SRV_PID" 2>/dev/null || true; fi
    wait "$SRV_PID" 2>/dev/null || true
    SRV_PID=""
  }
  start_mock 200
  run env METRICS_DIR="$MD" TRAFFIC_TOKEN=tok REPO=owner/name GITHUB_API_URL="$MOCK_URL" node "$MA/update-clone-traffic.mjs"
  assert_eq "(metrics) with a token: exits 0" 0 "$RC"
  assert "(metrics) ...called the traffic API with the bearer token" grep -q 'GET /repos/owner/name/traffic/clones Bearer tok' "$TMP_BASE/mock.log"
  assert "(metrics) ...merged the new days into the history" grep -q '"2026-01-03"' "$MD/clone-traffic.json"
  assert "(metrics) ...kept the old day" grep -q '"2025-12-31"' "$MD/clone-traffic.json"
  assert "(metrics) ...refreshed the 'updated' stamp" test "$(grep -c '2025-12-31T00:00:00.000Z' "$MD/clone-traffic.json")" = 0
  stop_mock
  cp "$MD/clone-traffic.json" "$TMP_BASE/json.afterok"
  start_mock 403
  run env METRICS_DIR="$MD" TRAFFIC_TOKEN=tok REPO=owner/name GITHUB_API_URL="$MOCK_URL" node "$MA/update-clone-traffic.mjs"
  assert "(metrics) an API error (403) exits non-zero" test "$RC" -ne 0
  assert "(metrics) ...and leaves the history alone" cmp -s "$MD/clone-traffic.json" "$TMP_BASE/json.afterok"
  stop_mock
else
  printf 'SKIP: (metrics) node not installed\n'
fi

# ===========================================================================
# workflows: YAML, wiring, and the clone-traffic job logic against a local "origin"
# ===========================================================================
WF="$ROOT/.github/workflows"
HAVE_RUBY=0
command -v ruby >/dev/null 2>&1 && ruby -ryaml -e 'exit 0' 2>/dev/null && HAVE_RUBY=1
if [ "$HAVE_RUBY" = 1 ]; then
  BADYAML=""
  for f in "$WF"/*.yml; do
    ruby -ryaml -e 'YAML.load_file(ARGV[0])' "$f" 2>/dev/null || BADYAML="$BADYAML $(basename "$f")"
  done
  assert "(workflows) every workflow parses as YAML (bad:${BADYAML:- none})" test -z "$BADYAML"
else
  printf 'SKIP: (workflows) ruby/yaml not available: YAML parse not run\n'
fi
assert "(workflows) scripts/lint-md-bash.sh is run by a workflow" grep -lq 'scripts/lint-md-bash.sh' "$WF"/*.yml
for pat in '"install.ps1"' '"setup.ps1"' 'tests/installer/test-install.ps1' 'test-scripts.sh'; do
  assert "(workflows) installer.yml mentions $pat" grep -q -F "$pat" "$WF/installer.yml"
done
assert "(workflows) installer.yml runs the PowerShell tests under pwsh" grep -q 'pwsh .*tests/installer/test-install.ps1' "$WF/installer.yml"
assert "(workflows) clone-traffic.yml does not check out metrics-data in the main checkout" test -z "$(grep -n 'git checkout .*metrics-data' "$WF/clone-traffic.yml")"
assert "(workflows) clone-traffic.yml points the script at the metrics-data worktree" grep -q 'METRICS_DIR:' "$WF/clone-traffic.yml"

# --- recipe-tests.yml: paths cover every skill; node --test gets files, not directories ---
RT="$WF/recipe-tests.yml"
rt_paths() { # <push|pull_request>: the quoted entries of that trigger's paths list
  awk -v ev="$1" '
    /^on:/ { inon = 1; next }
    inon && /^[a-z]/ { inon = 0 }
    inon && $1 == ev ":" { cur = 1; next }
    inon && /^  [a-z_]+:/ { cur = 0 }
    inon && cur && /^      - "/ { gsub(/^      - "|"$/, ""); print }' "$RT"
}
PUSH_PATHS="$(rt_paths push)"
PR_PATHS="$(rt_paths pull_request)"
assert "(recipe-tests) push and pull_request path lists are identical and non-empty" test -n "$PUSH_PATHS" -a "$PUSH_PATHS" = "$PR_PATHS"
UNCOVERED=""
for f in "$ROOT"/skills/*/SKILL.md; do
  rel="skills/$(basename "$(dirname "$f")")/SKILL.md"
  hit=0
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    # shellcheck disable=SC2254
    case "$rel" in $pat) hit=1 ;; esac
  done <<EOF
$PUSH_PATHS
EOF
  [ "$hit" = 1 ] || UNCOVERED="$UNCOVERED $rel"
done
assert "(recipe-tests) every skills/*/SKILL.md change triggers the workflow (uncovered:${UNCOVERED:- none})" test -z "$UNCOVERED"
for pat in 'templates/*' 'tests/skills/x' 'VERSIONS.txt'; do
  hit=0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    # shellcheck disable=SC2254
    case "$pat" in $p) hit=1 ;; esac
  done <<EOF
$PUSH_PATHS
EOF
  assert "(recipe-tests) a change to $pat triggers the workflow" test "$hit" = 1
done

# Node 20's directory form ran: .js/.cjs/.mjs files named test, test-*, *.test / *-test / *_test (or under a dir named test).
node20_dir_set() { # <dir>
  (cd "$ROOT" && find "$1" -type f \( -name '*.js' -o -name '*.cjs' -o -name '*.mjs' \) -not -path '*/node_modules/*' | LC_ALL=C sort |
    while IFS= read -r f; do
      b="$(basename "$f")"
      b="${b%.*}"
      if printf '%s\n' "$b" | grep -Eq '^test$|^test-.+|.+[._-]test$'; then printf '%s\n' "$f"; fi
    done)
}
list_files() { # the non-flag arguments, one per line (a case/esac inside $( ) trips bash 3.2)
  local a
  for a in "$@"; do
    if [ "${a#-}" = "$a" ]; then printf '%s\n' "$a"; fi
  done
}
NODE_CMDS="$(grep -E '^[[:space:]]+run: node --test' "$RT" | sed 's/^[[:space:]]*run: node --test//')"
assert "(recipe-tests) the workflow has node --test steps" test -n "$NODE_CMDS"
BADFORM=""
while IFS= read -r args; do
  [ -n "$args" ] || continue
  first_arg="$(list_files $args | head -1)"
  case "$first_arg" in
    tests/acceptance/docker/*) dir=tests/acceptance/docker ;;
    tests/acceptance/*) dir=tests/acceptance ;;
    tests/founder-brief/*) dir=tests/founder-brief ;;
    tests/recipes/*) dir=tests/recipes ;;
    tests/skills/*) dir=tests/skills ;;
    *) BADFORM="$BADFORM [unknown:$args]"; continue ;;
  esac
  # unquoted globs, expanded by the shell exactly as the runner's bash will
  got="$(cd "$ROOT" && list_files $args | LC_ALL=C sort)"
  want="$(node20_dir_set "$dir")"
  case "$args" in *\"*|*\'*) BADFORM="$BADFORM [quoted:$args]" ;; esac
  if [ "$got" != "$want" ]; then BADFORM="$BADFORM [$dir: file set differs from the directory form]"; fi
done <<EOF
$NODE_CMDS
EOF
assert "(recipe-tests) every node --test step lists the same files as the old directory form, as unquoted globs (problems:${BADFORM:- none})" test -z "$BADFORM"

if [ "$HAVE_RUBY" = 1 ] && [ "$HAVE_NODE" = 1 ] && command -v git >/dev/null 2>&1; then
  # Extract the run steps of clone-traffic.yml and execute them (as `bash -e`, like Actions)
  # against a local bare origin: the script that runs must be MAIN's, the data lands on metrics-data.
  CT="$TMP_BASE/ct"
  mkdir -p "$CT"
  ruby -ryaml -e '
    wf = YAML.load_file(ARGV[0])
    sub = {
      "secrets.TRAFFIC_TOKEN" => "${TEST_TRAFFIC_TOKEN}",
      "github.repository" => "owner/name",
      "runner.temp" => "${RUNNER_TEMP}",
    }
    expand = lambda { |v| v.to_s.gsub(/\$\{\{\s*([\w.]+)\s*\}\}/) { sub.fetch($1) { abort("unknown expression #{$1}") } } }
    i = 0
    wf["jobs"]["track"]["steps"].each do |st|
      next unless st["run"]
      i += 1
      File.open(File.join(ARGV[1], "step-#{i}.sh"), "w") do |f|
        f.puts "set -e"
        (st["env"] || {}).each { |k, v| f.puts "export #{k}=\"#{expand.call(v)}\"" }
        f.puts "cd \"#{expand.call(st["working-directory"])}\"" if st["working-directory"]
        f.puts expand.call(st["run"])
      end
      File.write(File.join(ARGV[1], "step-#{i}.name"), st["name"].to_s)
    end
  ' "$WF/clone-traffic.yml" "$CT"
  STEPS="$(ls "$CT"/step-*.sh 2>/dev/null | wc -l | tr -d ' ')"
  assert "(clone-traffic) extracted the run steps ($STEPS)" test "$STEPS" -ge 3

  gitc() {
    GIT_AUTHOR_NAME=Anonymous GIT_AUTHOR_EMAIL=anonymous@example.invalid \
      GIT_COMMITTER_NAME=Anonymous GIT_COMMITTER_EMAIL=anonymous@example.invalid \
      GIT_CONFIG_NOSYSTEM=1 HOME="$TMP_BASE/githome" git "$@"
  }
  mkdir -p "$TMP_BASE/githome"
  # a fresh origin with main, and optionally a metrics-data branch carrying a STALE copy of the script
  make_origin() { # <dir> <with-metrics-data: 0|1>
    local d="$1" w="$1.work"
    rm -rf "$d" "$w"
    gitc init -q --bare "$d"
    gitc -C "$d" symbolic-ref HEAD refs/heads/main
    mkdir -p "$w/metrics"
    gitc -C "$w" init -q
    gitc -C "$w" symbolic-ref HEAD refs/heads/main
    cp "$ROOT/metrics/update-clone-traffic.mjs" "$w/metrics/"
    cp "$TMP_BASE/json.orig" "$w/metrics/clone-traffic.json"
    gitc -C "$w" add -A >/dev/null
    gitc -C "$w" commit -q -m main
    gitc -C "$w" push -q "$d" main
    if [ "$2" = 1 ]; then
      gitc -C "$w" checkout -q -b metrics-data
      printf 'console.log("STALE SCRIPT RAN"); process.exit(0);\n' >"$w/metrics/update-clone-traffic.mjs"
      gitc -C "$w" commit -q -am stale
      gitc -C "$w" push -q "$d" metrics-data
    fi
  }
  run_steps() { # <origin> <checkout dir> <token>: runs every extracted step; stops at the first failure
    local origin="$1" co="$2" token="$3" n=1
    rm -rf "$co" "$TMP_BASE/runner-temp"
    mkdir -p "$TMP_BASE/runner-temp"
    gitc clone -q "$origin" "$co"
    gitc -C "$co" fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
    OUT=""
    while [ -f "$CT/step-$n.sh" ]; do
      OUT="$OUT$(cd "$co" && env GITHUB_WORKSPACE="$co" RUNNER_TEMP="$TMP_BASE/runner-temp" TEST_TRAFFIC_TOKEN="$token" \
        GITHUB_API_URL="$MOCK_URL" HOME="$TMP_BASE/githome" bash -e "$CT/step-$n.sh" 2>&1)"
      RC=$?
      OUT="$OUT"$'\n'
      if [ "$RC" -ne 0 ]; then return "$RC"; fi
      n=$((n + 1))
    done
    return 0
  }

  start_mock 200
  # (1) stale script on the metrics-data branch: main's script must run, data lands on metrics-data
  make_origin "$TMP_BASE/origin1.git" 1
  MAIN1="$(gitc -C "$TMP_BASE/origin1.git" rev-parse main)"
  run_steps "$TMP_BASE/origin1.git" "$TMP_BASE/co1" tok
  assert_eq "(clone-traffic) with an existing metrics-data branch: all steps succeed" 0 "$RC"
  [ "$RC" = 0 ] || printf '%s\n' "$OUT"
  DATA="$(gitc -C "$TMP_BASE/origin1.git" show metrics-data:metrics/clone-traffic.json 2>/dev/null)"
  case "$DATA" in *'"2026-01-03"'*) pass "(clone-traffic) the history on metrics-data was updated by the script" ;; *) fail "(clone-traffic) the history on metrics-data was updated by the script" "$DATA" ;; esac
  case "$OUT" in *"STALE SCRIPT RAN"*) fail "(clone-traffic) the stale script on metrics-data was NOT executed" ;; *) pass "(clone-traffic) the stale script on metrics-data was NOT executed (main's ran)" ;; esac
  assert "(clone-traffic) the branch still carries its own (stale) script file, untouched" \
    test "$(gitc -C "$TMP_BASE/origin1.git" show metrics-data:metrics/update-clone-traffic.mjs)" = 'console.log("STALE SCRIPT RAN"); process.exit(0);'
  assert "(clone-traffic) the SVG was committed to metrics-data too" gitc -C "$TMP_BASE/origin1.git" cat-file -e metrics-data:metrics/clone-traffic.svg
  assert_eq "(clone-traffic) main was not touched" "$MAIN1" "$(gitc -C "$TMP_BASE/origin1.git" rev-parse main)"
  assert "(clone-traffic) the commit message is the metrics one" test "$(gitc -C "$TMP_BASE/origin1.git" log -1 --format=%s metrics-data)" = "chore(metrics): update clone traffic [skip ci]"

  # (2) first run: no metrics-data yet -> created from main, which carries the seeded history
  make_origin "$TMP_BASE/origin2.git" 0
  MAIN2="$(gitc -C "$TMP_BASE/origin2.git" rev-parse main)"
  run_steps "$TMP_BASE/origin2.git" "$TMP_BASE/co2" tok
  assert_eq "(clone-traffic) first run (no metrics-data branch): all steps succeed" 0 "$RC"
  [ "$RC" = 0 ] || printf '%s\n' "$OUT"
  DATA="$(gitc -C "$TMP_BASE/origin2.git" show metrics-data:metrics/clone-traffic.json 2>/dev/null)"
  case "$DATA" in *'"2026-01-03"'*'"2025-12-31"'* | *'"2025-12-31"'*'"2026-01-03"'*) pass "(clone-traffic) first run: metrics-data created from main's seeded history plus the new days" ;; *) fail "(clone-traffic) first run: metrics-data created from main's seeded history plus the new days" "$DATA" ;; esac
  assert_eq "(clone-traffic) first run: main was not touched" "$MAIN2" "$(gitc -C "$TMP_BASE/origin2.git" rev-parse main)"

  # (3) a missing secret fails the run and pushes nothing
  make_origin "$TMP_BASE/origin3.git" 1
  BEFORE3="$(gitc -C "$TMP_BASE/origin3.git" rev-parse metrics-data)"
  run_steps "$TMP_BASE/origin3.git" "$TMP_BASE/co3" ""
  assert "(clone-traffic) a missing TRAFFIC_TOKEN makes the job fail" test "$RC" -ne 0
  assert_eq "(clone-traffic) ...and nothing was pushed to metrics-data" "$BEFORE3" "$(gitc -C "$TMP_BASE/origin3.git" rev-parse metrics-data)"
  stop_mock
else
  printf 'SKIP: (clone-traffic) needs ruby, node and git: workflow logic not run\n'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
