import { CORE_GUIDES, INTEGRATION_GUIDES, PLATFORM_GUIDES } from "./guide-content.js";

// hstack catalog shown on the website. Mirrors the tier_members table in install.sh
// (the source of truth); keep the two in sync when a tier changes.
// Logos live in public/logos/<id>.(svg|png); see public/logos/README.md for sources.

export const HERMES_VERSION = "0.23.2";

const logo = (id, ext = "svg") => `/logos/${id}.${ext}`;

export const PLATFORMS = [
  { id: "telegram", name: "Telegram", logo: logo("telegram"), note: "BotFather token + user-ID allowlist" },
  { id: "discord", name: "Discord", logo: logo("discord"), note: "Bot token + Message Content intent" },
  { id: "whatsapp", name: "WhatsApp", logo: logo("whatsapp"), note: "Baileys bridge, QR pairing" },
  { id: "slack", name: "Slack", logo: logo("slack"), note: "Socket Mode, no public endpoint" },
  { id: "mattermost", name: "Mattermost", logo: logo("mattermost"), note: "Server URL + bot token" },
  { id: "teams", name: "Microsoft Teams", logo: logo("teams"), note: "Azure AD bot credentials" },
  { id: "google-chat", name: "Google Chat", logo: logo("google-chat"), note: "Cloud Pub/Sub pull subscription" },
  { id: "signal", name: "Signal", logo: logo("signal"), note: "signal-cli HTTP daemon" },
].map(platform => ({ ...platform, summary: PLATFORM_GUIDES[platform.id].summary }));

const item = (id, name, ext) => ({ id, name, logo: logo(id, ext), skill: `integration-${id}`, summary: INTEGRATION_GUIDES[id].summary });

export const TIERS = [
  { id: "memory", name: "Memory", blurb: "Long-term recall. Pick one.", items: [item("mem0", "mem0"), item("supermemory", "Supermemory")] },
  { id: "database", name: "Database", blurb: "Read and query your data.", items: [item("supabase", "Supabase"), item("postgres", "Postgres"), item("neon", "Neon"), item("redis", "Redis")] },
  { id: "vector", name: "Vector", blurb: "Semantic search stores.", items: [item("pinecone", "Pinecone"), item("qdrant", "Qdrant")] },
  { id: "auth", name: "Auth", blurb: "Users and sessions.", items: [item("auth0", "Auth0"), item("clerk", "Clerk")] },
  { id: "observability", name: "Observability", blurb: "Errors, metrics and events.", items: [item("posthog", "PostHog"), item("sentry", "Sentry"), item("datadog", "Datadog"), item("segment", "Segment")] },
  { id: "rag", name: "RAG", blurb: "Feed the web into context.", items: [item("firecrawl", "Firecrawl")] },
  { id: "code", name: "Code", blurb: "Sandboxed code execution.", items: [item("e2b", "E2B", "png")] },
  { id: "ai-tools", name: "AI tools", blurb: "Image, audio, embeddings, batch.", items: [item("openai-tools", "OpenAI tools"), item("elevenlabs", "ElevenLabs"), item("replicate", "Replicate")] },
  { id: "storage", name: "Storage", blurb: "Object storage.", items: [item("r2", "Cloudflare R2")] },
  { id: "crm", name: "CRM", blurb: "Contacts, deals and pipelines.", items: [item("hubspot", "HubSpot"), item("salesforce", "Salesforce"), item("pipedrive", "Pipedrive"), item("zoho-crm", "Zoho CRM")] },
  { id: "docs", name: "Docs", blurb: "Notes, files and knowledge.", items: [item("notion", "Notion"), item("google-workspace", "Google Workspace"), item("microsoft-365", "Microsoft 365"), item("obsidian", "Obsidian")] },
  { id: "dev", name: "Dev", blurb: "Repositories, issues and PRs.", items: [item("github", "GitHub"), item("gitlab", "GitLab"), item("bitbucket", "Bitbucket")] },
  { id: "pm", name: "Project management", blurb: "Tasks, boards and sprints.", items: [item("jira", "Jira"), item("linear", "Linear"), item("asana", "Asana"), item("clickup", "ClickUp"), item("monday", "monday.com"), item("trello", "Trello"), item("airtable", "Airtable")] },
  { id: "cloud", name: "Cloud", blurb: "Infrastructure and hosting.", items: [item("aws", "AWS"), item("gcp", "Google Cloud"), item("azure", "Azure"), item("digitalocean", "DigitalOcean"), item("hetzner", "Hetzner"), item("cloudflare", "Cloudflare"), item("vercel", "Vercel"), item("netlify", "Netlify"), item("railway", "Railway"), item("render", "Render")] },
  { id: "payments", name: "Payments", blurb: "Charges, refunds and payouts.", items: [item("stripe", "Stripe"), item("paypal", "PayPal"), item("razorpay", "Razorpay")] },
  { id: "commerce", name: "Commerce", blurb: "Stores and sites.", items: [item("shopify", "Shopify"), item("woocommerce", "WooCommerce"), item("webflow", "Webflow"), item("wordpress", "WordPress")] },
  { id: "email", name: "Email", blurb: "Campaigns and transactional mail.", items: [item("mailchimp", "Mailchimp"), item("brevo", "Brevo"), item("sendgrid", "SendGrid"), item("postmark", "Postmark", "png")] },
  { id: "support", name: "Support", blurb: "Tickets, chat and SMS.", items: [item("twilio", "Twilio"), item("sendbird", "Sendbird", "png"), item("intercom", "Intercom"), item("zendesk", "Zendesk"), item("freshdesk", "Freshdesk", "png")] },
  { id: "forms", name: "Forms & meetings", blurb: "Forms, bookings and calls.", items: [item("typeform", "Typeform"), item("tally", "Tally"), item("calendly", "Calendly"), item("zoom", "Zoom")] },
  { id: "search", name: "Search", blurb: "Live web search.", items: [item("brave-search", "Brave Search"), item("tavily", "Tavily"), item("exa", "Exa")] },
];

export const INTEGRATION_COUNT = TIERS.reduce((sum, tier) => sum + tier.items.length, 0);

export const CORE_SKILLS = [
  { name: "hermes-install", copy: "Install the pinned Hermes release on your server." },
  { name: "hermes-deploy", copy: "End-to-end: install, model, platform, memory, personality." },
  { name: "hermes-model", copy: "Pick the model provider Hermes talks to." },
  { name: "hermes-soul", copy: "Give your agent a name and personality." },
  { name: "hermes-home", copy: "Set where cron output and notices go." },
  { name: "hermes-memory", copy: "Wire long-term memory." },
  { name: "hermes-skills", copy: "Install a pack of third-party Hermes skills." },
  { name: "hermes-mcp-add", copy: "Probe and register any HTTP MCP server." },
  { name: "hermes-integrate", copy: "Wire several apps in one sitting." },
  { name: "hermes-cron", copy: "Schedule recurring jobs." },
  { name: "hermes-status", copy: "Health check the gateway and platforms." },
  { name: "hermes-restart", copy: "Restart the gateway and wait until ready." },
  { name: "hermes-update", copy: "Move to a new release safely." },
  { name: "hermes-backup", copy: "Snapshot config, secrets and memory." },
  { name: "hermes-fix", copy: "Diagnose and repair a broken install." },
  { name: "setup-ssh-keys", copy: "Key-based SSH so every skill runs unattended." },
  { name: "blueprint-install", copy: "Install a reviewed blueprint in dependency order." },
  { name: "blueprint-saas-founder", copy: "Compose a reviewable SaaS founder blueprint." },
].map(skill => ({ ...skill, title: CORE_GUIDES[skill.name].title, copy: CORE_GUIDES[skill.name].summary }));

export const SKILL_COUNT = CORE_SKILLS.length + PLATFORMS.length + INTEGRATION_COUNT;

export const CODING_AGENTS = [
  { id: "claude-code", name: "Claude Code", logo: logo("claude-code"), dir: "~/.claude/skills/" },
  { id: "codex", name: "Codex", logo: logo("codex"), dir: "~/.agents/skills/" },
  { id: "cursor", name: "Cursor", logo: logo("cursor"), dir: "~/.cursor/rules/" },
  { id: "gemini", name: "Gemini CLI", logo: logo("gemini"), dir: "~/.gemini/context/hstack/" },
  { id: "openclaw", name: "OpenClaw", logo: logo("openclaw"), dir: "~/.openclaw/skills/" },
  { id: "hermes", name: "Hermes", logo: logo("hermes"), dir: "~/.hermes/skills/" },
];

export const INSTALL_COMMANDS = [
  { id: "mac", label: "macOS / Linux", command: "curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash" },
  { id: "all", label: "Everything", command: "curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash -s -- --all" },
  { id: "windows", label: "Windows", command: "iwr -useb https://raw.githubusercontent.com/paarths-collab/hstack/main/install.ps1 | iex" },
];
