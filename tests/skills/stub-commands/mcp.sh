#!/bin/bash
# shellcheck shell=bash disable=SC2154
# (sourced by ../hermes, which defines H, K, CFG, ENVF, event, inject, upsert_env, gw_state, mcp_names and mcp_field)
# Test behaviour of the `hermes mcp` subcommands the main stub does not model itself: catalog, picker, install, login, reauth,
# configure. NOT Hermes. Sourced by the hermes stub from its `mcp)` branch ($@ starts at `mcp`; the global `-p default` is
# already removed and the real v0.22.5 argparse has accepted the argv). `add`, `remove`, `list` and `test` live in the main stub.
#
# Messages, order of steps and exit codes are copied from hermes_cli/mcp_picker.py, hermes_cli/mcp_catalog.py and
# hermes_cli/mcp_config.py at v0.22.5; what the vendor SERVER does is an assumption steered by knobs:
#   fail.mcp.probe   the probe cannot connect
#   mcp_oauth_ok     `mcp login` succeeds and caches a token (writes $H/mcp-oauth/<name>.json)
#
# Real behaviours reproduced on purpose (each one matters to a skill):
#   * the catalog is 100% HTTP at v0.22.5: 56 OAuth entries, 10 no-auth entries, 0 API-key entries; the stub lists the exact HTTP catalog
#     with the real auth type and endpoint of each (optional-mcps/<name>/manifest.yaml);
#   * `mcp install NAME` on an OAuth entry writes the entry, cannot probe without cached tokens ("Couldn't probe server;
#     installed with no tool filter"), and still exits 0 - the server is installed but NOT signed in;
#   * `mcp login` returns None, i.e. exit 0 even when authentication failed (mcp_config.py:983-987): only `mcp test` tells;
#   * `mcp install` of a name that is not in the catalog exits 1 (mcp_picker.py:215-219);
#   * `mcp configure` needs a TTY (mcp_config.py:1040-1043).

# Manifest names, auth, URLs and descriptions below are copied from the exact pinned source.
MCP_CATALOG="airtable:oauth:Bases, tables, and records from your Airtable workspace.
algolia:oauth:Algolia search  indices, analytics, and settings (read-only).
alltrails:none:AllTrails  find hikes and trails with reviews and ratings.
amplitude:oauth:Amplitude analytics  charts, dashboards, experiments, flags.
asana:oauth:Tasks, projects, and goals from your Asana workspace.
atlassian:oauth:Jira issues and Confluence pages via Atlassian's hosted remote MCP.
attio:oauth:CRM records, lists, and notes in Attio.
aws-knowledge:none:Authoritative AWS docs, API references, and best practices.
betterstack:oauth:Better Stack  logs, uptime monitors, incidents, and status pages.
buildkite:oauth:CI/CD pipelines, builds, and test results from Buildkite.
calendly:oauth:Scheduling links, events, and invitees from Calendly.
canva:oauth:Create, search, and manage Canva designs.
circleci:oauth:CircleCI  diagnose build failures, read logs, rerun workflows.
clickup:oauth:Tasks, docs, and workspaces in ClickUp.
close:oauth:Sales CRM  leads, opportunities, calls, and emails.
cloudflare:oauth:Full Cloudflare API access via the official remote MCP.
cloudinary:oauth:Upload, search, and transform media assets in Cloudinary.
comfy-cloud:oauth:Generate images, video, audio, and 3D on Comfy Cloud.
context7:none:Up-to-date, version-specific library docs and code examples.
craft:oauth:Craft  structured docs, tasks, and personal knowledge base.
datadog:oauth:Logs, monitors, dashboards, and incidents from Datadog.
deepwiki:none:Ask questions about any public GitHub repo (Devin's DeepWiki).
dropbox:oauth:Search, read, and manage files in Dropbox.
figma:oauth:Official Figma remote MCP — design context, Code Connect, and write-to-canvas via https //mcp.figma.com/mcp (OAuth).
fireflies:oauth:Meeting transcripts, summaries, and action items.
gamma:oauth:Gamma  generate and edit AI presentations, docs, and sites.
gitlab:oauth:GitLab  issues, merge requests, pipelines, and repo context.
globalping:oauth:Ping, traceroute, DNS, and HTTP tests from global probes.
grafana:oauth:Query metrics, logs, dashboards, alerts, and incidents from Grafana Cloud.
hugging_face:oauth:Models, datasets, Spaces, and papers from the Hugging Face Hub.
indeed:oauth:Search jobs and listings on Indeed.
intercom:oauth:Conversations, tickets, and customer data from Intercom.
kiwi:none:Kiwi.com flight search  itineraries with direct booking links.
klaviyo:oauth:Klaviyo marketing  campaigns, flows, segments, and reporting.
linear:oauth:Find, create, and update Linear issues, projects, and comments.
microsoft-learn:none:Official Microsoft, Azure, and .NET docs and code samples.
miro:oauth:Read and edit Miro boards, diagrams, and frames.
mixpanel:oauth:Mixpanel analytics  events, funnels, retention, dashboards.
monday:oauth:Boards, items, docs, and workflows in monday.com.
motherduck:oauth:MotherDuck  query DuckDB cloud warehouses with SQL.
n8n-official:oauth:Connect to your n8n instance's official MCP server with browser OAuth.
neon:oauth:Neon serverless Postgres  projects, branches, and SQL.
netlify:oauth:Sites, deploys, and env vars via Netlify's hosted MCP.
notion:oauth:Pages and databases from your Notion workspace.
paypal:oauth:Payments, invoices, and subscriptions via PayPal's hosted MCP.
plaid:oauth:Plaid dashboard  integrations, Items, and usage debugging.
postman:oauth:Postman workspaces, collections, environments, and APIs.
prisma-postgres:oauth:Create and manage Prisma Postgres databases.
railway:oauth:Railway  projects, services, deployments, and environments.
rentahuman:oauth:Find people and manage real-world work through RentAHuman.
robinhood:oauth:Robinhood agentic trading  portfolio, balances, and orders.
semgrep:oauth:Scan code for security vulnerabilities with Semgrep.
sentry:oauth:Issues, stack traces, and error context from Sentry.
square:oauth:Catalog, orders, and payments via Square's hosted MCP.
strava:oauth:Strava  activities, fitness trends, training load (read-only).
stripe:oauth:Payments, customers, and invoices via Stripe's hosted MCP.
supabase:oauth:Database, auth, and storage from your Supabase projects.
todoist:oauth:Manage Todoist tasks and projects.
trivago:none:trivago hotel search  compare prices by city and dates.
twelve-data:oauth:Stocks, forex, and crypto market data from Twelve Data.
twilio-docs:none:Twilio developer docs search (public beta, read-only).
unreal-engine:none:Drive the Unreal Engine 5.8 editor over its local MCP server.
vercel:oauth:Deployments, logs, and projects via Vercel's hosted MCP.
webflow:oauth:Sites, CMS collections, and pages via Webflow's hosted MCP.
wolfram:none:Wolfram|Alpha computation, math, and curated knowledge.
wordpress-com:oauth:WordPress.com  posts, pages, drafts, stats, and comments."

mcpx_catalog_url() {
  case "$1" in
    airtable) printf '%s\n' 'https://mcp.airtable.com/mcp' ;;
    algolia) printf '%s\n' 'https://mcp.algolia.com/mcp' ;;
    alltrails) printf '%s\n' 'https://www.alltrails.com/mcp' ;;
    amplitude) printf '%s\n' 'https://mcp.amplitude.com/mcp' ;;
    asana) printf '%s\n' 'https://mcp.asana.com/v2/mcp' ;;
    atlassian) printf '%s\n' 'https://mcp.atlassian.com/v1/mcp/authv2' ;;
    attio) printf '%s\n' 'https://mcp.attio.com/mcp' ;;
    aws-knowledge) printf '%s\n' 'https://knowledge-mcp.global.api.aws' ;;
    betterstack) printf '%s\n' 'https://mcp.betterstack.com' ;;
    buildkite) printf '%s\n' 'https://mcp.buildkite.com/mcp' ;;
    calendly) printf '%s\n' 'https://mcp.calendly.com' ;;
    canva) printf '%s\n' 'https://mcp.canva.com/mcp' ;;
    circleci) printf '%s\n' 'https://mcp.circleci.com/v1/mcp' ;;
    clickup) printf '%s\n' 'https://mcp.clickup.com/mcp' ;;
    close) printf '%s\n' 'https://mcp.close.com/mcp' ;;
    cloudflare) printf '%s\n' 'https://mcp.cloudflare.com/mcp?codemode=false' ;;
    cloudinary) printf '%s\n' 'https://asset-management.mcp.cloudinary.com/mcp' ;;
    comfy-cloud) printf '%s\n' 'https://cloud.comfy.org/mcp' ;;
    context7) printf '%s\n' 'https://mcp.context7.com/mcp' ;;
    craft) printf '%s\n' 'https://mcp.craft.do/my/mcp' ;;
    datadog) printf '%s\n' 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp' ;;
    deepwiki) printf '%s\n' 'https://mcp.deepwiki.com/mcp' ;;
    dropbox) printf '%s\n' 'https://mcp.dropbox.com/mcp' ;;
    figma) printf '%s\n' 'https://mcp.figma.com/mcp' ;;
    fireflies) printf '%s\n' 'https://api.fireflies.ai/mcp' ;;
    gamma) printf '%s\n' 'https://mcp.gamma.app/mcp' ;;
    gitlab) printf '%s\n' 'https://gitlab.com/api/v4/mcp' ;;
    globalping) printf '%s\n' 'https://mcp.globalping.dev/mcp' ;;
    grafana) printf '%s\n' 'https://mcp.grafana.com/mcp' ;;
    hugging_face) printf '%s\n' 'https://huggingface.co/mcp' ;;
    indeed) printf '%s\n' 'https://mcp.indeed.com/claude/mcp' ;;
    intercom) printf '%s\n' 'https://mcp.intercom.com/mcp' ;;
    kiwi) printf '%s\n' 'https://mcp.kiwi.com' ;;
    klaviyo) printf '%s\n' 'https://mcp.klaviyo.com/mcp?core-tools-only=true&disable-tools-with-user-generated-content=true' ;;
    linear) printf '%s\n' 'https://mcp.linear.app/mcp' ;;
    microsoft-learn) printf '%s\n' 'https://learn.microsoft.com/api/mcp' ;;
    miro) printf '%s\n' 'https://mcp.miro.com/' ;;
    mixpanel) printf '%s\n' 'https://mcp.mixpanel.com/mcp' ;;
    monday) printf '%s\n' 'https://mcp.monday.com/mcp' ;;
    motherduck) printf '%s\n' 'https://api.motherduck.com/mcp' ;;
    n8n-official) printf '%s\n' '${N8N_MCP_SERVER_URL}' ;;
    neon) printf '%s\n' 'https://mcp.neon.tech/mcp' ;;
    netlify) printf '%s\n' 'https://netlify-mcp.netlify.app/mcp' ;;
    notion) printf '%s\n' 'https://mcp.notion.com/mcp' ;;
    paypal) printf '%s\n' 'https://mcp.paypal.com/sse' ;;
    plaid) printf '%s\n' 'https://api.dashboard.plaid.com/mcp/' ;;
    postman) printf '%s\n' 'https://mcp.postman.com/minimal' ;;
    prisma-postgres) printf '%s\n' 'https://mcp.prisma.io/mcp' ;;
    railway) printf '%s\n' 'https://mcp.railway.com' ;;
    rentahuman) printf '%s\n' 'https://rentahuman.ai/api/mcp' ;;
    robinhood) printf '%s\n' 'https://agent.robinhood.com/mcp/trading' ;;
    semgrep) printf '%s\n' 'https://mcp.semgrep.ai/mcp' ;;
    sentry) printf '%s\n' 'https://mcp.sentry.dev/mcp' ;;
    square) printf '%s\n' 'https://mcp.squareup.com/sse' ;;
    strava) printf '%s\n' 'https://mcp.strava.com/mcp' ;;
    stripe) printf '%s\n' 'https://mcp.stripe.com' ;;
    supabase) printf '%s\n' 'https://mcp.supabase.com/mcp' ;;
    todoist) printf '%s\n' 'https://ai.todoist.net/mcp' ;;
    trivago) printf '%s\n' 'https://mcp.trivago.com/mcp' ;;
    twelve-data) printf '%s\n' 'https://mcp.twelvedata.com/mcp' ;;
    twilio-docs) printf '%s\n' 'https://mcp.twilio.com/docs' ;;
    unreal-engine) printf '%s\n' 'http://127.0.0.1:8000/mcp' ;;
    vercel) printf '%s\n' 'https://mcp.vercel.com' ;;
    webflow) printf '%s\n' 'https://mcp.webflow.com/mcp' ;;
    wolfram) printf '%s\n' 'https://agenttools.wolfram.com/mcp' ;;
    wordpress-com) printf '%s\n' 'https://public-api.wordpress.com/wpcom/v2/mcp/v1' ;;
    *) return 1 ;;
  esac
}

mcpx_catalog_auth() { printf '%s\n' "$MCP_CATALOG" | awk -F: -v n="$1" '$1==n{print $2}'; }
mcpx_status() { case $(mcp_field "$1" enabled) in false) echo disabled ;; *) echo enabled ;; esac; }
mcpx_remove() {
  [ -f "$CFG" ] || return 0
  awk -v b="mcp.$1:" -v p="mcp_servers.$1." '$0==b{skip=1; next} skip&&/^[ ]/{next} {skip=0} index($0,p)==1{next} {print}' "$CFG" > "$CFG.tmp"
  cat "$CFG.tmp" > "$CFG"; rm -f "$CFG.tmp"
}

mcpx_catalog() {
  event mcp catalog
  local line n st d
  echo; echo "  MCP Catalog + configured servers:"; echo
  printf '  %-18s %-24s %s\n' Name Status Description
  printf '  %-18s %-24s %s\n' "------------------" "------------------------" "-----------"
  while IFS= read -r line; do
    n=${line%%:*}; d=${line#*:*:}
    if ! mcp_names | grep -qxF -- "$n"; then st="available"; elif [ "$(mcpx_status "$n")" = enabled ]; then st="enabled"; else st="installed (disabled)"; fi
    printf '  %-18s %-24s %s\n' "$n" "$st" "$d"
  done <<EOF
$MCP_CATALOG
EOF
  for n in $(mcp_names); do
    printf '%s\n' "$MCP_CATALOG" | awk -F: -v n="$n" '$1==n{f=1} END{exit !f}' && continue
    if [ "$(mcpx_status "$n")" = enabled ]; then st="custom — enabled"; else st="custom — disabled"; fi
    printf '  %-18s %-24s %s\n' "$n" "$st" "$(mcp_field "$n" url)$(mcp_field "$n" command)"
  done
  echo; echo "  Install: hermes mcp install <name>    Picker: hermes mcp"; echo
}

mcpx_install() {
  local id=${1#official/} a
  event mcp install "$id"; inject mcp.install
  a=$(mcpx_catalog_auth "$id")
  if [ -z "$a" ]; then echo "  ✗ '$1' is not in the catalog. Run \`hermes mcp catalog\` to see available entries."; return 1; fi
  echo; echo "  Installing MCP '$id'"; echo
  mcpx_remove "$id"
  { echo "mcp.$id:"; printf '  url: %s\n' "$(mcpx_catalog_url "$id")"; [ "$a" = oauth ] && echo "  auth: oauth"; echo "  enabled: true"; } >> "$CFG"
  [ "$a" = oauth ] && echo "  This MCP uses native OAuth 2.1; tokens will be acquired on first connection (browser flow)."
  echo; echo "  Probing '$id' for available tools..."
  if [ -f "$K/fail.mcp.probe" ] || { [ "$a" = oauth ] && [ ! -f "$H/mcp-oauth/$id.json" ]; }; then
    echo "  Probe failed: MCP OAuth for '$id': non-interactive environment and no cached tokens found."
    echo "  Couldn't probe server; installed with no tool filter (all tools enabled when reachable). Run \`hermes mcp configure $id\` after first connect to prune."
  fi
  echo; echo "  ✓ Installed '$id' (enabled). Start a new Hermes session to load its tools."
  [ "$a" = oauth ] && { echo; echo "  On first connection, Hermes will open a browser to authenticate with $id."; }
  echo
  return 0
}

mcpx_login() {
  local n=${1:-}
  event mcp login "$n"
  if ! mcp_names | grep -qxF -- "$n"; then echo "  ✗ Server '$n' not found in config."; return 0; fi
  if [ "$(mcp_field "$n" auth)" != oauth ]; then
    echo "  ✗ Server '$n' is not configured for OAuth (auth=$(mcp_field "$n" auth))"
    echo '  Use `hermes mcp remove` + `hermes mcp add` to reconfigure auth.'
    return 0
  fi
  echo; echo "  Starting OAuth flow for '$n'..."
  printf '\n  MCP OAuth: open https://auth.example.test/device on any device.\n  Code: ABCD-EFGH\n  Waiting for approval...\n\n' >&2
  if [ -f "$K/mcp_oauth_ok" ]; then
    mkdir -p "$H/mcp-oauth"; echo '{}' > "$H/mcp-oauth/$n.json"
    echo "  ✓ Authenticated — 2 tool(s) available"
  else
    echo "  ✗ Authentication failed: timed out waiting for approval"
  fi
  return 0   # cmd_mcp_login returns None: exit 0 either way
}

hermes_cmd() {
  shift   # "mcp"
  case "${1:-}" in
    catalog|picker|"") mcpx_catalog ;;
    install) shift; mcpx_install "$@" ;;
    login) shift; mcpx_login "$@" ;;
    reauth) event mcp reauth "${2:-}"; echo "  No OAuth-based MCP servers found in config." ;;
    configure|config) event mcp configure "${2:-}"; echo "Error: 'hermes mcp configure' requires an interactive terminal." >&2; return 1 ;;
    *) event unknown "mcp $*"; echo "hermes: unknown: mcp $*" >&2; return 99 ;;
  esac
}
