// platform-discord / platform-slack / platform-mattermost: the real SKILL.md blocks against a simulated VPS
// (helpers/sandbox.mjs). One table drives the checks the three skills share; platform-specific cases follow.
//
// What the stubs are: syntax = the real v0.22.5 argparse (hermes stub); behaviour = assumptions written in the stubs.
// Vendor answers come from the curl stub (valid_tokens + curl_routes). Nothing here proves a real Discord, Slack or
// Mattermost call works; it proves ORDER, GATING, SECRET HANDLING, LOG VERDICTS and ROLLBACK of the skill text.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, symlinkSync } from "node:fs";

import { assertNoSecretInArgv, assertSecretsNotPrinted, assertStateChanged, assertStateIdentical, idx, writeEvents } from "./helpers/asserts.mjs";
import { assemble, loadBlocks, mustReplace, skillPath } from "./helpers/blocks.mjs";
import { SCRIPT_END, scenario } from "./helpers/sandbox.mjs";

// ---- fake credentials, assembled at run time so no token-shaped literal sits in the repository ----
const join = (...p) => p.join("");
const body = (tag, n) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = `${tag}`;
  while (s.length < n) s += alphabet;
  return s.slice(0, n);
};
const dcToken = (tag = "A") => join(body(tag, 24), ".", body("x", 6), ".", body("y", 27));
const slackBot = (tag = "A") => join("xo", "xb-", "1234567890-0987654321-", body(tag, 24));
const slackApp = (tag = "A") => join("xa", "pp-1-A0123456789-", body(tag, 40));
const mmToken = (tag = "A") => body(tag, 26);

const DC_GOOD = dcToken("G"), DC_OLD = dcToken("O");
const SB_GOOD = slackBot("G"), SB_OLD = slackBot("O"), SA_GOOD = slackApp("G"), SA_OLD = slackApp("O");
const MM_GOOD = mmToken("g"), MM_OLD = mmToken("o");

const DC_ID = "123456789012345678", DC_ID2 = "223456789012345678", DC_ID_OLD = "111111111111111111";
const SL_ID = "U012ABCDE3F", SL_ID2 = "W012ABCDE4G", SL_ID_OLD = "U0OLDUSER11";
const MM_ID = "abcdefghij0123456789abcdef", MM_ID2 = "zyxwvutsrq9876543210zyxwvu", MM_ID_OLD = "oldoldoldo0123456789oldold";
const MM_URL = "https://chat.example.test";

const tab = (...cols) => cols.join("\t");
const routes = (...lines) => lines.join("\n") + "\n";

// ---- log fixtures (line shapes copied from the v0.22.5 adapters; see the skills' "Verified" sections) ----
const START = "2026-10-25 10:00:00 INFO gateway.run: Starting Hermes Gateway...";
const logLines = (...l) => l.join("\n") + "\n";

const PLATFORMS = [
  {
    key: "discord", skill: "platform-discord", label: "Discord",
    usersVar: "DISCORD_ALLOWED_USERS", users: DC_ID, users2: DC_ID2, oldUsers: DC_ID_OLD,
    homeVar: "DISCORD_HOME_CHANNEL", home: "323456789012345678", badHome: "general",
    tokenVars: ["DISCORD_BOT_TOKEN"], secrets: [DC_GOOD], oldSecrets: [DC_OLD],
    inputs: (over = {}) => ({ DISCORD_BOT_TOKEN: DC_GOOD, DISCORD_ALLOWED_USERS: DC_ID, ...over }),
    valid: [DC_GOOD, DC_OLD],
    routes: routes(tab("applications/@me", JSON.stringify({ id: "999999999999999999", name: "Hermes Bot", flags: 262144, bot: { username: "hermes" } }))),
    pre: 1, post: 1,
    // keys written to .env, in order, for (hasHome, extras)
    envOrder: (home) => ["DISCORD_ALLOWED_USERS", ...(home ? ["DISCORD_HOME_CHANNEL"] : []), "DISCORD_BOT_TOKEN"],
    oldEnv: `FOO=bar\nDISCORD_BOT_TOKEN=${DC_OLD}\nDISCORD_ALLOWED_USERS=${DC_ID_OLD}\nOTHER_KEY=keep-me\n`,
    oldCfg: "model.default: old/model\nplatforms.discord.enabled: true\n",
    tokenLines: `DISCORD_BOT_TOKEN=${DC_OLD}\n`,
    envWith: (users, extra = "") => `DISCORD_BOT_TOKEN=${DC_OLD}\nDISCORD_ALLOWED_USERS=${users}\n${extra}`,
    preflightMsg: /ABORT: Discord .*did not accept the bot token/,
    verdictFn: "dc_connected",
    goodLog: logLines(START, "2026-10-25 10:00:03 INFO plugins.platforms.discord.adapter: [Discord] Connected as Hermes#1234", "2026-10-25 10:00:04 INFO gateway.run: ✓ discord connected", "2026-10-25 10:00:04 INFO gateway.run: Gateway running with 1 platform(s)"),
    adapterOnly: logLines(START, "2026-10-25 10:00:03 INFO x: [Discord] Connected as Hermes#1234"),
    gatewayOnly: logLines(START, "2026-10-25 10:00:04 INFO gateway.run: ✓ discord connected"),
    failAfter: ["2026-10-25 10:00:09 ERROR x: [Discord] Failed to connect to Discord: boom", "2026-10-25 10:00:09 INFO x: ✓ discord disconnected (0.20s)", "2026-10-25 10:00:09 WARNING x: ✗ discord failed to connect", "2026-10-25 10:00:09 ERROR x: [Discord] Timeout waiting for connection to Discord", "2026-10-25 10:00:09 ERROR x: [Discord] Discord gateway task exited: closed", "2026-10-25 10:00:09 INFO x: [Discord] Disconnected", "2026-10-25 10:00:09 ERROR x: ✗ discord error: boom"],
    degraded: logLines(START, "x: [Discord] Connected as Hermes#1234", "x: ✓ discord connected (degraded)"),
    reconnect: logLines(START, "x: [Discord] Connected as Hermes#1234", "x: ✓ discord connected", "x: [Discord] Disconnected", "x: [Discord] Connected as Hermes#1234", "x: ✓ discord reconnected successfully"),
    otherPlatform: logLines(START, "x: ✓ telegram connected", "x: [Slack] Socket Mode connected (1 workspace(s))", "x: Mattermost: WebSocket connected and authenticated", "x: ✓ slack connected", "x: ✓ mattermost connected"),
    openEnv: [["DISCORD_ALLOW_ALL_USERS=true", /DISCORD_ALLOW_ALL_USERS/], ["GATEWAY_ALLOW_ALL_USERS=1", /GATEWAY_ALLOW_ALL_USERS/], ["export DISCORD_ALLOW_ALL_USERS=yes", /DISCORD_ALLOW_ALL_USERS/], ['GATEWAY_ALLOW_ALL_USERS="true"', /GATEWAY_ALLOW_ALL_USERS/], ["DISCORD_ALLOW_ALL_USERS=anything-else", /DISCORD_ALLOW_ALL_USERS/], [" GATEWAY_ALLOW_ALL_USERS = true", /GATEWAY_ALLOW_ALL_USERS/], [`DISCORD_ALLOWED_ROLES=${DC_ID}`, /DISCORD_ALLOWED_ROLES/], ["DISCORD_ALLOW_BOTS=all", /DISCORD_ALLOW_BOTS/], ["DISCORD_ALLOW_BOTS=mentions", /DISCORD_ALLOW_BOTS/], ["GATEWAY_ALLOWED_USERS=*", /GATEWAY_ALLOWED_USERS/], ["GATEWAY_ALLOWED_USERS=111,*", /GATEWAY_ALLOWED_USERS/]],
    openCfg: [["allow_all_users: true", /allow_all_users/], ["gateway:\n  allow_all_users: yes", /allow_all_users/], ["discord:\n  allow_all_users: 'true'", /allow_all_users/], ["discord:\n  allow_bots: all", /allow_bots/], ["discord:\n  allowed_roles: [123456789012345678]", /allowed_roles/], ["discord:\n  allowed_roles:\n    - 123456789012345678", /allowed_roles/]],
    offLines: ["DISCORD_ALLOW_ALL_USERS=false\nGATEWAY_ALLOW_ALL_USERS=0\nDISCORD_ALLOW_BOTS=none\n", "GATEWAY_ALLOW_ALL_USERS=off\nDISCORD_ALLOW_ALL_USERS=no\nDISCORD_ALLOWED_ROLES=\n"],
    offCfg: "allow_all_users: false\ndiscord:\n  allow_bots: none\n  allowed_roles: []\n",
    badUsers: [["16 digits", "1234567890123456"], ["21 digits", "123456789012345678901"], ["a name", "alice"], ["a mention", "<@123456789012345678>"]],
    unsafeEnv: [["wildcard after an id", `DISCORD_ALLOWED_USERS=${DC_ID_OLD},*\n`], ["a user name", `DISCORD_ALLOWED_USERS=${DC_ID_OLD},alice\n`], ["duplicate allowlist", `DISCORD_ALLOWED_USERS=${DC_ID_OLD}\nDISCORD_ALLOWED_USERS=${DC_ID}\n`], ["gateway open-access override", `DISCORD_ALLOWED_USERS=${DC_ID_OLD}\nGATEWAY_ALLOW_ALL_USERS=true\n`], ["exported open-access override", `DISCORD_ALLOWED_USERS=${DC_ID_OLD}\nexport DISCORD_ALLOW_ALL_USERS=1\n`], ["role grant", `DISCORD_ALLOWED_USERS=${DC_ID_OLD}\nDISCORD_ALLOWED_ROLES=${DC_ID}\n`], ["bot grant", `DISCORD_ALLOWED_USERS=${DC_ID_OLD}\nDISCORD_ALLOW_BOTS=all\n`], ["duplicate token", `DISCORD_ALLOWED_USERS=${DC_ID_OLD}\nDISCORD_BOT_TOKEN=${DC_OLD}\n`]],
    quotedSafe: `DISCORD_BOT_TOKEN="${DC_OLD}"\nDISCORD_ALLOWED_USERS='${DC_ID_OLD},${DC_ID}'\nGATEWAY_ALLOW_ALL_USERS=false\n`,
    badTokens: [["double quote", { DISCORD_BOT_TOKEN: `${DC_GOOD}"x` }], ["command substitution", { DISCORD_BOT_TOKEN: `${DC_GOOD}$(touch "$HOME/pwned")` }], ["newline", { DISCORD_BOT_TOKEN: `${DC_GOOD}\nX=1` }], ["space", { DISCORD_BOT_TOKEN: `${DC_GOOD} x` }], ["the numeric application id", { DISCORD_BOT_TOKEN: "123456789012345678" }], ["no dot", { DISCORD_BOT_TOKEN: body("n", 59) }], ["empty", { DISCORD_BOT_TOKEN: "" }]],
    badTokenMsg: /ABORT: DISCORD_BOT_TOKEN/,
    envNames: ["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USERS", "DISCORD_HOME_CHANNEL"],
  },
  {
    key: "slack", skill: "platform-slack", label: "Slack",
    usersVar: "SLACK_ALLOWED_USERS", users: SL_ID, users2: SL_ID2, oldUsers: SL_ID_OLD,
    homeVar: "SLACK_HOME_CHANNEL", home: "C0123456789", badHome: "#general",
    tokenVars: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"], secrets: [SB_GOOD, SA_GOOD], oldSecrets: [SB_OLD, SA_OLD],
    inputs: (over = {}) => ({ SLACK_BOT_TOKEN: SB_GOOD, SLACK_APP_TOKEN: SA_GOOD, SLACK_ALLOWED_USERS: SL_ID, ...over }),
    valid: [SB_GOOD, SA_GOOD, SB_OLD, SA_OLD],
    routes: routes(
      tab("auth.test", JSON.stringify({ ok: true, url: "https://acme.slack.com/", team: "Acme", user: "hermes", team_id: "T0123456789", user_id: "U0BOT000001" })),
      tab("apps.connections.open", JSON.stringify({ ok: true, url: "wss://wss-primary.slack.example/link/?ticket=abc" })),
    ),
    pre: 2, post: 2,
    envOrder: (home) => ["SLACK_ALLOWED_USERS", ...(home ? ["SLACK_HOME_CHANNEL"] : []), "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    oldEnv: `FOO=bar\nSLACK_BOT_TOKEN=${SB_OLD}\nSLACK_APP_TOKEN=${SA_OLD}\nSLACK_ALLOWED_USERS=${SL_ID_OLD}\nOTHER_KEY=keep-me\n`,
    oldCfg: "model.default: old/model\nplatforms.slack.enabled: true\n",
    tokenLines: `SLACK_BOT_TOKEN=${SB_OLD}\nSLACK_APP_TOKEN=${SA_OLD}\n`,
    envWith: (users, extra = "") => `SLACK_BOT_TOKEN=${SB_OLD}\nSLACK_APP_TOKEN=${SA_OLD}\nSLACK_ALLOWED_USERS=${users}\n${extra}`,
    preflightMsg: /ABORT: Slack .*did not accept the (bot|app) token/,
    verdictFn: "slack_connected",
    goodLog: logLines(START, "2026-10-25 10:00:02 INFO x: [Slack] Authenticated as @hermes in workspace Acme (team: T0123456789)", "2026-10-25 10:00:03 INFO x: [Slack] Socket Mode connected (1 workspace(s))", "2026-10-25 10:00:04 INFO gateway.run: ✓ slack connected"),
    adapterOnly: logLines(START, "x: [Slack] Socket Mode connected (1 workspace(s))"),
    gatewayOnly: logLines(START, "x: ✓ slack connected"),
    failAfter: ["x: [Slack] Connection failed: invalid_auth", "x: [Slack] SLACK_APP_TOKEN not set — this is a permanent config error", "x: [Slack] Disconnected", "x: ✓ slack disconnected (0.10s)", "x: ✗ slack failed to connect", "x: ✗ slack error: boom", "x: [Slack] slack-bolt not installed. Run: pip install slack-bolt"],
    degraded: logLines(START, "x: [Slack] Socket Mode connected (1 workspace(s))", "x: ✓ slack connected (degraded)"),
    reconnect: logLines(START, "x: [Slack] Socket Mode connected (1 workspace(s))", "x: ✓ slack connected", "x: [Slack] Disconnected", "x: [Slack] Socket Mode connected (1 workspace(s))", "x: ✓ slack reconnected successfully"),
    otherPlatform: logLines(START, "x: ✓ telegram connected", "x: [Discord] Connected as Hermes#1234", "x: Mattermost: WebSocket connected and authenticated", "x: ✓ discord connected", "x: ✓ mattermost connected"),
    openEnv: [["SLACK_ALLOW_ALL_USERS=true", /SLACK_ALLOW_ALL_USERS/], ["GATEWAY_ALLOW_ALL_USERS=1", /GATEWAY_ALLOW_ALL_USERS/], ["export SLACK_ALLOW_ALL_USERS=yes", /SLACK_ALLOW_ALL_USERS/], ['GATEWAY_ALLOW_ALL_USERS="true"', /GATEWAY_ALLOW_ALL_USERS/], ["SLACK_ALLOW_BOTS=all", /SLACK_ALLOW_BOTS/], ["SLACK_ALLOW_BOTS=mentions", /SLACK_ALLOW_BOTS/], ["GATEWAY_ALLOWED_USERS=*", /GATEWAY_ALLOWED_USERS/], ["GATEWAY_ALLOWED_USERS=U012ABCDE3F,*", /GATEWAY_ALLOWED_USERS/]],
    openCfg: [["allow_all_users: true", /allow_all_users/], ["gateway:\n  allow_all_users: yes", /allow_all_users/], ["slack:\n  allow_bots: all", /allow_bots/], ["slack:\n  allow_bots: mentions", /allow_bots/]],
    offLines: ["SLACK_ALLOW_ALL_USERS=false\nGATEWAY_ALLOW_ALL_USERS=0\nSLACK_ALLOW_BOTS=none\n", "GATEWAY_ALLOW_ALL_USERS=off\nSLACK_ALLOW_ALL_USERS=no\n"],
    offCfg: "allow_all_users: false\nslack:\n  allow_bots: none\n",
    badUsers: [["a handle", "@alice"], ["lower case", "u012abcde3f"], ["too short", "U1"], ["a channel id", "C0123456789"]],
    unsafeEnv: [["wildcard after an id", `SLACK_ALLOWED_USERS=${SL_ID_OLD},*\n`], ["a handle", `SLACK_ALLOWED_USERS=${SL_ID_OLD},@alice\n`], ["duplicate allowlist", `SLACK_ALLOWED_USERS=${SL_ID_OLD}\nSLACK_ALLOWED_USERS=${SL_ID}\n`], ["gateway open-access override", `SLACK_ALLOWED_USERS=${SL_ID_OLD}\nGATEWAY_ALLOW_ALL_USERS=true\n`], ["exported open-access override", `SLACK_ALLOWED_USERS=${SL_ID_OLD}\nexport SLACK_ALLOW_ALL_USERS=1\n`], ["bot grant", `SLACK_ALLOWED_USERS=${SL_ID_OLD}\nSLACK_ALLOW_BOTS=all\n`], ["duplicate bot token", `SLACK_ALLOWED_USERS=${SL_ID_OLD}\nSLACK_BOT_TOKEN=${SB_OLD}\n`], ["duplicate app token", `SLACK_ALLOWED_USERS=${SL_ID_OLD}\nSLACK_APP_TOKEN=${SA_OLD}\n`]],
    quotedSafe: `SLACK_BOT_TOKEN="${SB_OLD}"\nSLACK_APP_TOKEN='${SA_OLD}'\nSLACK_ALLOWED_USERS='${SL_ID_OLD},${SL_ID}'\nGATEWAY_ALLOW_ALL_USERS=false\n`,
    badTokens: [["a user token", { SLACK_BOT_TOKEN: join("xo", "xp-", body("u", 40)) }], ["the app token in the bot slot", { SLACK_BOT_TOKEN: SA_GOOD }], ["two workspaces", { SLACK_BOT_TOKEN: `${SB_GOOD},${slackBot("B")}` }], ["quote", { SLACK_BOT_TOKEN: `${SB_GOOD}"x` }], ["command substitution", { SLACK_BOT_TOKEN: `${SB_GOOD}$(touch "$HOME/pwned")` }], ["empty bot", { SLACK_BOT_TOKEN: "" }], ["the bot token in the app slot", { SLACK_APP_TOKEN: SB_GOOD }], ["the signing secret", { SLACK_APP_TOKEN: body("s", 32) }], ["newline in the app token", { SLACK_APP_TOKEN: `${SA_GOOD}\nX=1` }], ["empty app", { SLACK_APP_TOKEN: "" }]],
    badTokenMsg: /ABORT: SLACK_(BOT|APP)_TOKEN/,
    envNames: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_ALLOWED_USERS", "SLACK_HOME_CHANNEL"],
  },
  {
    key: "mattermost", skill: "platform-mattermost", label: "Mattermost",
    usersVar: "MATTERMOST_ALLOWED_USERS", users: MM_ID, users2: MM_ID2, oldUsers: MM_ID_OLD,
    homeVar: "MATTERMOST_HOME_CHANNEL", home: "channelid0123456789abcdefg", badHome: "town-square",
    tokenVars: ["MATTERMOST_TOKEN"], secrets: [MM_GOOD], oldSecrets: [MM_OLD],
    inputs: (over = {}) => ({ MATTERMOST_URL: MM_URL, MATTERMOST_TOKEN: MM_GOOD, MATTERMOST_ALLOWED_USERS: MM_ID, ...over }),
    valid: [MM_GOOD, MM_OLD],
    routes: routes(tab("/api/v4/users/me", JSON.stringify({ id: "botbotbot0123456789botbotbo", username: "hermes", is_bot: true }))),
    pre: 1, post: 1,
    envOrder: (home) => ["MATTERMOST_ALLOWED_USERS", ...(home ? ["MATTERMOST_HOME_CHANNEL"] : []), "MATTERMOST_URL", "MATTERMOST_TOKEN"],
    oldEnv: `FOO=bar\nMATTERMOST_URL=https://old.example.test\nMATTERMOST_TOKEN=${MM_OLD}\nMATTERMOST_ALLOWED_USERS=${MM_ID_OLD}\nOTHER_KEY=keep-me\n`,
    oldCfg: "model.default: old/model\nplatforms.mattermost.enabled: true\n",
    tokenLines: `MATTERMOST_URL=${MM_URL}\nMATTERMOST_TOKEN=${MM_OLD}\n`,
    envWith: (users, extra = "") => `MATTERMOST_URL=${MM_URL}\nMATTERMOST_TOKEN=${MM_OLD}\nMATTERMOST_ALLOWED_USERS=${users}\n${extra}`,
    preflightMsg: /ABORT: Mattermost .*did not accept the token/,
    verdictFn: "mm_connected",
    goodLog: logLines(START, "x: Mattermost: authenticated as @hermes (botbotbot0123456789botbotbo) on https://chat.example.test", "x: Mattermost: connecting to wss://chat.example.test/api/v4/websocket", "x: Mattermost: WebSocket connected and authenticated", "x: ✓ mattermost connected"),
    adapterOnly: logLines(START, "x: Mattermost: WebSocket connected and authenticated"),
    gatewayOnly: logLines(START, "x: Mattermost: authenticated as @hermes (id) on https://chat.example.test", "x: ✓ mattermost connected"),
    failAfter: ["x: Mattermost: failed to authenticate — check MATTERMOST_TOKEN and MATTERMOST_URL", "x: Mattermost WS auth failed (HTTP 401) — stopping reconnect", "x: Mattermost WS error: boom — reconnecting in 2s", "x: Mattermost: WebSocket closed (1)", "x: Mattermost: disconnected", "x: ✓ mattermost disconnected (0.10s)", "x: ✗ mattermost failed to connect", "x: ✗ mattermost error: boom", "x: Mattermost: URL or token not configured", "x: Mattermost: aiohttp not installed"],
    degraded: logLines(START, "x: Mattermost: WebSocket connected and authenticated", "x: ✓ mattermost connected (degraded)"),
    reconnect: logLines(START, "x: Mattermost: WebSocket connected and authenticated", "x: ✓ mattermost connected", "x: Mattermost: WebSocket closed (1)", "x: Mattermost: connecting to wss://chat.example.test/api/v4/websocket", "x: Mattermost: WebSocket connected and authenticated"),
    otherPlatform: logLines(START, "x: ✓ telegram connected", "x: [Discord] Connected as Hermes#1234", "x: [Slack] Socket Mode connected (1 workspace(s))", "x: ✓ discord connected", "x: ✓ slack connected"),
    openEnv: [["MATTERMOST_ALLOW_ALL_USERS=true", /MATTERMOST_ALLOW_ALL_USERS/], ["GATEWAY_ALLOW_ALL_USERS=1", /GATEWAY_ALLOW_ALL_USERS/], ["export MATTERMOST_ALLOW_ALL_USERS=yes", /MATTERMOST_ALLOW_ALL_USERS/], ['GATEWAY_ALLOW_ALL_USERS="true"', /GATEWAY_ALLOW_ALL_USERS/], ["GATEWAY_ALLOWED_USERS=*", /GATEWAY_ALLOWED_USERS/], ["GATEWAY_ALLOWED_USERS=abc,*", /GATEWAY_ALLOWED_USERS/]],
    openCfg: [["allow_all_users: true", /allow_all_users/], ["gateway:\n  allow_all_users: yes", /allow_all_users/]],
    offLines: ["MATTERMOST_ALLOW_ALL_USERS=false\nGATEWAY_ALLOW_ALL_USERS=0\n", "GATEWAY_ALLOW_ALL_USERS=off\nMATTERMOST_ALLOW_ALL_USERS=no\n"],
    offCfg: "allow_all_users: false\n",
    badUsers: [["a handle", "@alice"], ["upper case", "ABCDEFGHIJ0123456789ABCDEF"], ["25 chars", "abcdefghij0123456789abcde"], ["27 chars", "abcdefghij0123456789abcdefg"]],
    unsafeEnv: [["wildcard after an id", `MATTERMOST_ALLOWED_USERS=${MM_ID_OLD},*\n`], ["a handle", `MATTERMOST_ALLOWED_USERS=${MM_ID_OLD},@alice\n`], ["duplicate allowlist", `MATTERMOST_ALLOWED_USERS=${MM_ID_OLD}\nMATTERMOST_ALLOWED_USERS=${MM_ID}\n`], ["gateway open-access override", `MATTERMOST_ALLOWED_USERS=${MM_ID_OLD}\nGATEWAY_ALLOW_ALL_USERS=true\n`], ["exported open-access override", `MATTERMOST_ALLOWED_USERS=${MM_ID_OLD}\nexport MATTERMOST_ALLOW_ALL_USERS=1\n`], ["duplicate token", `MATTERMOST_ALLOWED_USERS=${MM_ID_OLD}\nMATTERMOST_TOKEN=${MM_OLD}\n`]],
    quotedSafe: `MATTERMOST_URL="${MM_URL}"\nMATTERMOST_TOKEN="${MM_OLD}"\nMATTERMOST_ALLOWED_USERS='${MM_ID_OLD},${MM_ID}'\nGATEWAY_ALLOW_ALL_USERS=false\n`,
    badTokens: [["double quote", { MATTERMOST_TOKEN: `${MM_GOOD}"x` }], ["command substitution", { MATTERMOST_TOKEN: `${MM_GOOD}$(touch "$HOME/pwned")` }], ["newline", { MATTERMOST_TOKEN: `${MM_GOOD}\nX=1` }], ["space", { MATTERMOST_TOKEN: `${MM_GOOD} x` }], ["too short", { MATTERMOST_TOKEN: "abc123" }], ["empty", { MATTERMOST_TOKEN: "" }],
      ["no scheme", { MATTERMOST_URL: "chat.example.test" }], ["ftp scheme", { MATTERMOST_URL: "ftp://chat.example.test" }], ["query string", { MATTERMOST_URL: "https://chat.example.test/?a=b" }], ["credentials in the url", { MATTERMOST_URL: "https://user:pw@chat.example.test" }], ["space in the url", { MATTERMOST_URL: "https://chat.example.test x" }], ["quote in the url", { MATTERMOST_URL: "https://chat.example.test'x" }], ["empty url", { MATTERMOST_URL: "" }]],
    badTokenMsg: /ABORT: MATTERMOST_(TOKEN|URL)/,
    envNames: ["MATTERMOST_TOKEN", "MATTERMOST_URL", "MATTERMOST_ALLOWED_USERS", "MATTERMOST_HOME_CHANNEL"],
  },
];

const FLOW_IDS = ["step1#1", "step2#1", "step3#1", "step3#2", "step4#1", "step5#1", "step5#2", "step6#1", "step7#1", "step8#1", "step9#1"];
const flow = (P, { ids = FLOW_IDS, replace = [] } = {}) =>
  assemble(["set +e\n", { skill: P.skill, ids: ["before-you-start#1", "step0#1"], replace }, { skill: P.skill, ids, replace }, SCRIPT_END]);
const gateOnly = (P) => assemble(["set +e\n", { skill: P.skill, ids: ["step0#1", "step3#1"] }, SCRIPT_END]);

const writeKeys = (run) => run.sb.events().filter((e) => e.startsWith("hermes config set ")).map((e) => e.slice("hermes config set ".length));
const gwRestarts = (run) => run.sb.hermesCalls().filter((c) => c[0] === "gateway" && c[1] === "restart");
const sshIdx = (run, re, from = 0) => {
  const calls = run.sb.sshCalls();
  for (let i = from; i < calls.length; i++) if (re.test(calls[i])) return i;
  return -1;
};
const bak = (P, suffix = "") => `.hermes/.hstack-backup/${P.skill}${suffix}`;
const parseEnv = (text) => {
  const m = new Map();
  for (const l of text.split("\n")) {
    const k = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (k) m.set(k[1], [...(m.get(k[1]) || []), k[2]]);
  }
  return m;
};

for (const P of PLATFORMS) {
  const S = P.skill;
  const base = (over = {}) => ({ name: `${P.key}`, valid: P.valid, knobs: { curl_routes: P.routes }, files: { "logs.txt": P.goodLog }, script: flow(P), env: P.inputs(), ...over });
  const withHome = (over = {}) => P.inputs({ [P.homeVar]: P.home, ...over });

  describe(`${S}: shape of the skill text`, () => {
    const text = readFileSync(skillPath(S), "utf8");
    it("names Hermes 0.22.5, never calls retired lifecycle commands, never writes the invented *_ENABLED variable", () => {
      assert.match(text, /0\.22\.5/);
      for (const b of loadBlocks(S)) for (const l of b.code.split("\n")) {
        if (/^\s*#/.test(l)) continue;
        assert.ok(!/gateway (stop|run)\b|--daemon|hard_rollback/.test(l), `${b.id}: ${l}`);
        if (/echo|ABORT|FAIL|WARN/.test(l)) continue;
        assert.ok(!new RegExp(`${P.key.toUpperCase()}_ENABLED`).test(l), `${b.id}: ${l}`);
      }
    });
    it("has a Verified-against-Hermes-v0.22.5 section that states what was not run", () => {
      assert.match(text, /## Verified against Hermes v0\.22\.5/);
      assert.match(text, /not (been )?(run|called|exercised)|nothing was run|never (run|called)/i);
    });
  });

  describe(`${S}: good run`, { concurrency: 4 }, () => {
    for (const withH of [false, true]) {
      it(`${withH ? "with" : "without"} a home channel: preflight first, snapshot, real env names exactly once, gw_reload, connected log, finish`, async () => {
        await scenario(base({ name: `${P.key}-good-${withH}`, env: withH ? withHome() : P.inputs() }), async (run) => {
          assert.equal(run.code, 0, run.out);
          assert.ok(run.completed);
          // ---- vendor preflight (all calls) before the snapshot, snapshot before the first write
          const curls = run.sb.curlCalls();
          assert.equal(curls.length, P.pre + P.post, "preflight + read-back calls");
          for (const c of curls) {
            assert.equal(c.status, "200");
            assert.equal(c.argv_has_token, "0");
            assert.equal(c.token_has_dollar, "0");
            assert.ok(Number(c.token_len) > 8, "the credential must reach curl through the stdin config, expanded");
          }
          const snap = sshIdx(run, new RegExp(`SKILL_NAME='${S}' bash -s`));
          const firstSet = sshIdx(run, /config set/);
          assert.ok(snap > 0 && firstSet > snap, `snapshot (${snap}) must precede the first write (${firstSet})`);
          const before = run.sb.sshCalls().slice(0, snap).filter((c) => /curl /.test(c)).length;
          assert.equal(before, P.pre, "all preflight calls run before the snapshot");
          const ev = run.sb.events();
          assert.ok(idx(ev, /^curl status=200/) < idx(ev, /^hermes config set/));
          // ---- the keys Hermes v0.22.5 reads, exactly once each, in the safe order
          assert.deepEqual(writeKeys(run).filter((k) => /^[A-Z]/.test(k)), P.envOrder(withH));
          const env = parseEnv(run.sb.read(".hermes/.env"));
          for (const k of P.envOrder(withH)) assert.equal((env.get(k) || []).length, 1, `${k} must appear once`);
          assert.equal(env.get(P.usersVar)[0], P.users);
          if (withH) assert.equal(env.get(P.homeVar)[0], P.home);
          assert.ok(!env.has(`${P.key.toUpperCase()}_ENABLED`), "no invented *_ENABLED variable");
          assert.ok(![...env.keys()].some((k) => /ALLOW_ALL|ALLOW_BOTS|ALLOWED_ROLES|GROUP_ALLOWED/.test(k)));
          assert.equal(run.sb.mode(".hermes/.env"), 0o600);
          assert.ok(run.sb.read(".hermes/config.yaml").includes(`platforms.${P.key}.enabled: true`));
          for (const s of P.secrets) assert.ok(!run.sb.read(".hermes/config.yaml").includes(s), "tokens never go to config.yaml");
          // ---- native lifecycle, once; never the retired shapes
          const calls = run.sb.hermesCalls();
          assert.ok(calls.every((c) => c[0] !== "gateway" || !["stop", "run", "start"].includes(c[1])), "no stop/run/start");
          assert.equal(gwRestarts(run).length, 1);
          assert.deepEqual(gwRestarts(run)[0], ["gateway", "restart", "--detach"]);
          const lastSet = calls.map((c) => c[0] + " " + c[1]).lastIndexOf("config set");
          const restartAt = calls.findIndex((c) => c[0] === "gateway" && c[1] === "restart");
          assert.ok(restartAt > lastSet, "reload only after every write");
          // ---- verification and smoke
          assert.ok(idx(ev, /^hermes logs/) > idx(ev, /^hermes gateway restart/) || idx(ev, /^hermes logs/) > -1);
          assert.equal(ev.includes(`hermes send ${P.key}`), withH, "native send only with a home channel");
          if (withH) assert.ok(idx(ev, new RegExp(`^hermes send ${P.key}`)) > idx(ev, /^hermes logs/), "send smoke after the connected-log check");
          assert.ok(ev.includes("hermes pairing list"), "read-only pairing list is shown");
          assert.ok(!ev.some((e) => /pairing (approve|revoke|clear)/.test(e)), "the skill never approves anyone");
          assert.ok(run.sb.exists(bak(P, ".prev")));
          assert.ok(!run.sb.exists(bak(P)));
          assertNoSecretInArgv(run, P.secrets);
          assertSecretsNotPrinted(run, P.secrets);
        });
      });
    }

    it("allowlist normalisation: whitespace and empty entries are dropped, several ids are kept", async () => {
      await scenario(base({ name: `${P.key}-ws`, env: P.inputs({ [P.usersVar]: ` ${P.users} , ${P.users2},, ` }) }), async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.equal(parseEnv(run.sb.read(".hermes/.env")).get(P.usersVar)[0], `${P.users},${P.users2}`);
      });
    });

    it("an explicit platforms.<name>.enabled failure is only a WARN (the connected-log check decides)", async () => {
      await scenario(base({ name: `${P.key}-flag`, knobs: { curl_routes: P.routes, [`fail.set.platforms.${P.key}.enabled`]: true } }), async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.match(run.out, new RegExp(`WARN: could not set platforms\\.${P.key}\\.enabled`));
      });
    });

    it("already wired (safe stored setup) without FORCE: exits 0, no vendor call, nothing written", async () => {
      await scenario(base({ name: `${P.key}-idem`, seed: { env: P.envWith(P.oldUsers), config: P.oldCfg } }), async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.match(run.out, /already wired/i);
        assert.ok(!run.completed);
        assertStateIdentical(run);
        assert.equal(run.sb.curlCalls().length, 0);
        assert.deepEqual(writeEvents(run), []);
      });
    });

    it("stored quoted values and explicit off switches keep the safe idempotency path", async () => {
      await scenario(base({ name: `${P.key}-idem-q`, seed: { env: P.quotedSafe, config: P.oldCfg } }), async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.match(run.out, /already wired/i);
        assertStateIdentical(run);
      });
    });

    it("an explicit `platforms.<name>.enabled: false` is NOT reported as wired: the run continues and enables it", async () => {
      await scenario(base({ name: `${P.key}-idem-off`, seed: { env: P.envWith(P.oldUsers), config: `platforms.${P.key}.enabled: false\n` } }), async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.completed);
        assert.ok(!/already wired/i.test(run.out));
        assert.ok(run.sb.read(".hermes/config.yaml").includes(`platforms.${P.key}.enabled: true`));
      });
    });

    for (const [label, lines, mode] of [...P.unsafeEnv, ["world-readable env", "", 0o644]]) {
      it(`already wired with ${label}: aborts as unsafe, no vendor call or write`, async () => {
        const env = mode ? P.envWith(P.oldUsers) : P.tokenLines + lines;
        await scenario(base({ name: `${P.key}-idem-unsafe`, seed: { env, config: P.oldCfg, envMode: mode ?? 0o600 } }), async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, new RegExp(`stored ${P.label} setup is unsafe`));
          assert.ok(!/already wired/.test(run.out));
          assertStateIdentical(run);
          assert.deepEqual(writeEvents(run), []);
          assert.equal(run.sb.curlCalls().length, 0);
          assertSecretsNotPrinted(run, [...P.oldSecrets, ...P.secrets]);
        });
      });
    }

    it("Hermes version other than 0.22.5: ABORT before any vendor call or write", async () => {
      await scenario(base({ name: `${P.key}-ver`, files: { "hermes.version": "Hermes Agent v0.21.0\n", "logs.txt": P.goodLog } }), async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /ABORT: .*0\.22\.5/);
        assert.match(run.out, /Nothing was written/);
        assertStateIdentical(run);
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });
  });

  describe(`${S}: hard gate (nothing is written)`, { concurrency: 4 }, () => {
    it("vendor rejects the credential: ABORT, state byte-identical, no snapshot, no write, no second vendor call needed", async () => {
      await scenario(base({ name: `${P.key}-bad`, seed: { env: P.oldEnv, config: P.oldCfg }, valid: P.oldSecrets, env: P.inputs({ FORCE: "1" }) }), async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, P.preflightMsg);
        assert.match(run.out, /Nothing was written/);
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
        assert.ok(run.sb.curlCalls().length >= 1 && run.sb.curlCalls().length <= P.pre);
        assertSecretsNotPrinted(run, P.secrets);
      });
    });

    it("the VPS cannot reach the vendor: ABORT, nothing written", async () => {
      await scenario(base({ name: `${P.key}-net`, knobs: { curl_routes: P.routes, net_down: true } }), async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /^.*ABORT: /m);
        assert.match(run.out, /Nothing was written/);
        assert.deepEqual(writeEvents(run), []);
        assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      });
    });

    it("a vendor 5xx is a rejection, not a pass", async () => {
      await scenario(base({ name: `${P.key}-5xx`, knobs: { curl_routes: P.routes, curl_force: "1=503\n" } }), async (run) => {
        assert.equal(run.code, 1);
        assert.deepEqual(writeEvents(run), []);
      });
    });

    // Allowlist problems are caught by the LOCAL gate (Step 3, first block): no ssh, no curl at all.
    for (const [label, users, msg] of [
      ["empty", "", new RegExp(`${P.usersVar} is empty`)],
      ["only separators", " , ,", new RegExp(`${P.usersVar} is empty`)],
      ["*", "*", /contains a wildcard/],
      ["id,*", `${P.users},*`, /contains a wildcard/],
      ["*,id", `*,${P.users}`, /contains a wildcard/],
      ["negative id", "-100123", /invalid entries/],
      ["command injection", `${P.users}; touch "$HOME/pwned"`, /invalid entries/],
      ["command substitution", '$(touch "$HOME/pwned")', /invalid entries/],
      ...P.badUsers.map(([l, v]) => [l, v, /invalid entries/]),
    ]) {
      it(`allowlist ${JSON.stringify(label)} is refused before any ssh/curl`, async () => {
        await scenario(base({ name: `${P.key}-allow`, script: gateOnly(P), env: P.inputs({ [P.usersVar]: users }) }), async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, msg);
          assert.match(run.out, /Nothing was written/);
          assert.equal(run.sb.sshCalls().length, 0);
          assert.equal(run.sb.curlCalls().length, 0);
          assert.ok(!run.sb.exists("pwned"));
        });
      });
    }

    for (const [label, home, msg] of [
      ["several ids", `${P.home},${P.home}`, /takes ONE/],
      ["injection", `${P.home}; touch "$HOME/pwned"`, new RegExp(`invalid entries in ${P.homeVar}`)],
      ["a name", P.badHome, new RegExp(`invalid entries in ${P.homeVar}`)],
    ]) {
      it(`home channel ${JSON.stringify(label)} is refused before any ssh/curl`, async () => {
        await scenario(base({ name: `${P.key}-home`, script: gateOnly(P), env: withHome({ [P.homeVar]: home }) }), async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, msg);
          assert.equal(run.sb.sshCalls().length, 0);
          assert.equal(run.sb.curlCalls().length, 0);
          assert.ok(!run.sb.exists("pwned"));
        });
      });
    }

    for (const [label, over] of P.badTokens) {
      it(`credential input ${JSON.stringify(label)} is refused without any vendor call or write`, async () => {
        await scenario(base({ name: `${P.key}-tok`, script: flow(P), env: P.inputs(over) }), async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, P.badTokenMsg);
          assert.match(run.out, /Nothing was written/);
          assert.equal(run.sb.curlCalls().length, 0);
          assert.deepEqual(writeEvents(run), []);
          assert.ok(!run.sb.exists("pwned"));
          for (const v of Object.values(over)) if (v.length > 8) assert.ok(!run.sb.sshCalls().some((c) => c.includes(v)), "a rejected credential must not reach ssh");
        });
      });
    }

    // Open access already present on the VPS makes the allowlist meaningless (names only are ever printed).
    for (const [line, nameRe] of P.openEnv) {
      it(`pre-existing ${JSON.stringify(line)} in .env aborts before any write`, async () => {
        await scenario(base({ name: `${P.key}-open`, seed: { env: `FOO=bar\n${line}\n` } }), async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, /turns on open access/);
          assert.match(run.out.split("\n").find((l) => /turns on open access/.test(l)), nameRe);
          assertStateIdentical(run);
          assert.deepEqual(writeEvents(run), []);
          assert.equal(run.sb.curlCalls().length, 0);
          assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
        });
      });
    }
    for (const [line, nameRe] of P.openCfg) {
      it(`pre-existing ${JSON.stringify(line)} in config.yaml aborts before any write`, async () => {
        await scenario(base({ name: `${P.key}-open-cfg`, seed: { env: "FOO=bar\n", config: `${line}\n` } }), async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, /turns on open access/);
          assert.match(run.out.split("\n").find((l) => /turns on open access/.test(l)), nameRe);
          assertStateIdentical(run);
          assert.deepEqual(writeEvents(run), []);
          assert.equal(run.sb.curlCalls().length, 0);
        });
      });
    }
    for (const lines of P.offLines) {
      it(`explicitly-off switches (${lines.trim().split("\n").join(", ")}) do not block`, async () => {
        await scenario(base({ name: `${P.key}-off`, seed: { env: lines } }), async (run) => {
          assert.equal(run.code, 0, run.out);
          assert.ok(run.completed);
        });
      });
    }
    it("explicitly-off config.yaml switches do not block", async () => {
      await scenario(base({ name: `${P.key}-off-cfg`, seed: { env: "FOO=bar\n", config: P.offCfg } }), async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.completed);
      });
    });

    it("a .env that is a symlink aborts instead of passing the open-access check (FORCE=1 skips the idempotency check)", async () => {
      await scenario(base({ name: `${P.key}-symlink`, env: P.inputs({ FORCE: "1" }), setup: (sb) => { sb.write("elsewhere.env", "FOO=bar\n"); symlinkSync(sb.p("elsewhere.env"), sb.p(".hermes/.env")); } }), async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /ABORT: could not read/);
        assert.deepEqual(writeEvents(run), []);
        assert.equal(run.sb.curlCalls().length, 0);
      });
    });

    it("a leftover snapshot makes snapshot refuse; nothing is written", async () => {
      await scenario(base({ name: `${P.key}-left`, seed: { env: P.oldEnv, config: P.oldCfg }, env: P.inputs({ FORCE: "1" }), valid: [...P.valid], setup: (sb) => sb.write(`${bak(P)}/.env`, "junk\n") }), async (run) => {
        assert.equal(run.code, 1);
        assert.match(run.out, /did not finish/);
        assert.match(run.out, /ABORT: could not snapshot/);
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
      });
    });
  });

  describe(`${S}: failure after the snapshot restores byte for byte and reloads`, { concurrency: 4 }, () => {
    const firstEnvKey = P.envOrder(true)[0];
    const lastEnvKey = P.envOrder(true).slice(-1)[0];
    const cases = [
      ["gateway restart fails", { "fail.gateway.restart": true }, /gateway did not restart ready/, "early"],
      [`config set ${firstEnvKey} fails`, { [`fail.set.${firstEnvKey}`]: true }, new RegExp(`could not write ${firstEnvKey}`), "early"],
      [`config set ${lastEnvKey} fails (the rest already written)`, { [`fail.set.${lastEnvKey}`]: true }, new RegExp(`could not write ${lastEnvKey}`), "early"],
      ["third config set fails", { "fail.set_nth": "3\n" }, /could not write/, "early"],
      ["gateway logs unavailable", { "fail.logs": true }, /not confirmed connected/, "late"],
      ["post-write credential check is rejected", { curl_force: `${P.pre + 1}=401\n` }, /stored on the VPS/, "late"],
      ["open access appears during the write", { inject_allowall: `${lastEnvKey}\n` }, /turns on open access/, "early"],
      ["native send fails", { "fail.send": true }, /FAIL: .*hermes send/, "late"],
    ];
    for (const [label, knobs, msg, when] of cases) {
      it(`FORCE=1 re-run: ${label}`, async () => {
        const home = true;
        await scenario(base({ name: `${P.key}-rb`, seed: { env: P.oldEnv, config: P.oldCfg }, knobs: { curl_routes: P.routes, ...knobs }, env: withHome({ FORCE: "1" }), valid: P.valid }), async (run) => {
          if (knobs["fail.gateway.restart"]) {
            // reload refused, then rollback's own reload is refused too: files are restored, the snapshot is retained
            assert.equal(run.code, 1, run.out);
            assert.match(run.out, /gateway did NOT come back|gateway did not restart ready/);
            assertStateIdentical(run);
            assert.equal(run.sb.read(".hermes/.env"), P.oldEnv);
            assert.ok(run.sb.exists(bak(P)), "an unconfirmed gateway recovery keeps the active snapshot");
            assert.ok(!run.sb.exists(bak(P, ".prev")));
            const retry = assemble([{ skill: S, ids: ["step0#1"] }, 'rm "$HSTACK_FAKE/knobs/fail.gateway.restart"\nrollback || exit 1\necho RECOVERED\n']);
            const rec = await run.sb.run(retry);
            assert.equal(rec.code, 0, rec.out);
            assert.match(rec.out, /RECOVERED/);
            assert.ok(run.sb.exists(bak(P, ".prev")));
            assert.equal(run.sb.read(".hermes/.env"), P.oldEnv);
            return;
          }
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, msg);
          assert.match(run.out, /rollback: restored/);
          assertStateIdentical(run);
          assert.equal(run.sb.read(".hermes/.env"), P.oldEnv);
          assert.equal(run.sb.read(".hermes/config.yaml"), P.oldCfg);
          assert.equal(run.sb.mode(".hermes/.env"), 0o600);
          assert.ok(run.sb.exists(bak(P, ".prev")));
          assert.ok(!run.sb.exists(bak(P)));
          assert.ok(gwRestarts(run).length >= (when === "late" ? 2 : 1), `the restored state is loaded by a reload (restarts: ${gwRestarts(run).length})`);
          assert.ok(writeEvents(run).some((e) => e.startsWith("hermes config set")) || /open access/.test(String(msg)) === false);
          assertSecretsNotPrinted(run, [...P.secrets, ...P.oldSecrets]);
          void home;
        });
      });
    }

    for (const [label, log] of [
      ["no platform line at all", logLines(START, "x: Gateway running with 0 platform(s)")],
      ["only the gateway line", P.gatewayOnly],
      ["only the adapter line", P.adapterOnly],
      ["connected, then a failure line", P.goodLog + P.failAfter[0] + "\n"],
      ["connected, then disconnected", P.goodLog + P.failAfter[3] + "\n"],
      ["connected (degraded)", P.degraded],
      ["a stale success before a new process start", P.goodLog + START + "\n"],
      ["other platforms connected only", P.otherPlatform],
    ]) {
      it(`log verdict: ${label} cannot finish setup; previous state restored`, async () => {
        await scenario(base({ name: `${P.key}-neg`, seed: { env: P.oldEnv, config: P.oldCfg }, files: { "logs.txt": log }, env: P.inputs({ FORCE: "1" }), valid: P.valid }), async (run) => {
          assert.equal(run.code, 1, run.out);
          assert.match(run.out, /not confirmed connected/);
          assert.ok(!new RegExp(`OK: ${P.label} connected`).test(run.out));
          assertStateIdentical(run);
          assert.equal(run.sb.read(".hermes/.env"), P.oldEnv);
          assert.ok(gwRestarts(run).length >= 2);
          assert.ok(run.sb.exists(bak(P, ".prev")));
        });
      });
    }

    it("first run (no .env before): rollback removes the files this skill created", async () => {
      await scenario(base({ name: `${P.key}-rb-first`, knobs: { curl_routes: P.routes, "fail.logs": true } }), async (run) => {
        assert.equal(run.code, 1);
        assert.ok(!run.sb.exists(".hermes/.env"), ".env created by the run must be removed");
        assert.ok(!run.sb.exists(".hermes/config.yaml"));
        assertStateIdentical(run);
      });
    });

    it("rollback says so when the gateway does not come back, and keeps the snapshot for a retry", async () => {
      await scenario(base({ name: `${P.key}-rb-gw`, seed: { env: P.oldEnv, config: P.oldCfg }, knobs: { curl_routes: P.routes, "fail.gateway.restart": true }, env: P.inputs({ FORCE: "1" }) }), async (run) => {
        assert.match(run.out, /files restored, but the gateway did NOT come back/);
        assert.ok(run.sb.exists(bak(P)));
        assert.ok(!run.sb.exists(bak(P, ".prev")));
        assertStateIdentical(run);
      });
    });

    it("manual undo of a finished run: the .prev snapshot is restored and the gateway reloaded", async () => {
      await scenario(base({ name: `${P.key}-undo`, seed: { env: P.oldEnv, config: P.oldCfg }, env: withHome({ FORCE: "1" }) }), async (run) => {
        assert.equal(run.code, 0, run.out);
        assert.ok(run.sb.read(".hermes/.env") !== P.oldEnv);
        const undo = assemble([{ skill: S, ids: ["step0#1", "rollback#1"] }, 'echo UNDONE\n']);
        const u = await run.sb.run(undo);
        assert.equal(u.code, 0, u.out);
        assert.match(u.out, /UNDONE/);
        assert.equal(run.sb.read(".hermes/.env"), P.oldEnv);
        assert.equal(run.sb.read(".hermes/config.yaml"), P.oldCfg);
      });
    });
  });

  describe(`${S}: ${P.verdictFn} log verdict`, { concurrency: 8 }, () => {
    const verdict = async (text) => {
      let yes = false;
      await scenario({ name: `${P.key}-verdict`, files: { "sample.log": text }, script: assemble(["set +e\n", { skill: S, ids: ["step0#1"] }, `${P.verdictFn} < "$HOME/sample.log" && echo RESULT-YES || echo RESULT-NO\n`, SCRIPT_END]) }, async (run) => {
        assert.ok(run.completed, run.out);
        yes = run.out.includes("RESULT-YES");
      });
      return yes;
    };
    const cases = [
      ["the platform's own connected line AND the gateway's connected line", P.goodLog, true],
      ["empty log", "", false],
      ["only the gateway line", P.gatewayOnly, false],
      ["only the adapter line", P.adapterOnly, false],
      ["degraded", P.degraded, false],
      ["reconnect after a disconnect", P.reconnect, true],
      ["another platform's lines", P.otherPlatform, false],
      ["an old failure before a fresh start", logLines(P.failAfter[0], START, ...P.goodLog.split("\n").slice(1).filter(Boolean)), true],
      ...P.failAfter.map((f, i) => [`success followed by failure line #${i + 1}`, P.goodLog + f + "\n", false]),
      ["success, failure, then a clean new process with its own success", P.goodLog + P.failAfter[0] + "\n" + P.goodLog, true],
      ["success followed by a new process start with nothing yet", P.goodLog + START + "\n", false],
      ["upper case platform text does not matter", P.goodLog.toUpperCase(), true],
    ];
    for (const [label, text, want] of cases) {
      it(`${want ? "connected" : "NOT connected"}: ${label}`, async () => {
        assert.equal(await verdict(text), want);
      });
    }
  });

  describe(`${S}: negative controls (the tests can see the mistakes they guard against)`, { concurrency: 4 }, () => {
    it("CONTROL: a verdict that ignores later failure lines accepts the failing log (the negative-log tests would fail)", async () => {
      const code = loadBlocks(S).find((b) => b.id === "step0#1").code;
      const failRules = code.split("\n").filter((l) => /\{ (ad = 0|gw = 0; ad = 0) \}/.test(l) && !/starting\.hermes\.gateway/.test(l));
      assert.ok(failRules.length >= 1, "control cannot apply: no failure rule found in the verdict function");
      const replace = failRules.map((l) => [l, l.replace(/\{[^}]*\}\s*$/, "{ }")]);
      const script = assemble(["set +e\n", { skill: S, ids: ["step0#1"], replace }, `${P.verdictFn} < "$HOME/sample.log" && echo RESULT-YES || echo RESULT-NO\n`, SCRIPT_END]);
      for (const f of P.failAfter) {
        await scenario({ name: `${P.key}-ctl-verdict`, files: { "sample.log": P.goodLog + f + "\n" }, script }, async (run) => {
          // some failure lines reset only through one of the rules; every one of them must be accepted once both are neutralised
          assert.match(run.out, /RESULT-YES/, `the mutated verdict must wrongly accept: ${f}`);
        });
      }
    });

    it("CONTROL: without the reload call the good-run assertion about gateway restart would fail", async () => {
      const replace = [["gw_reload >/dev/null ||", "true ||"]];
      mustReplace({ skill: S, ids: ["step7#1"], replace });
      await scenario(base({ name: `${P.key}-ctl-reload`, script: flow(P, { replace }) }), async (run) => {
        assert.equal(gwRestarts(run).length, 0, "mutated script must not restart");
      });
    });

    it("CONTROL: without the open-access gate a pre-existing allow-all switch proceeds to write", async () => {
      const replace = [['if [ -n "$OPEN_NAMES" ]', "if false"]];
      mustReplace({ skill: S, ids: ["step3#2"], replace });
      await scenario(base({ name: `${P.key}-ctl-open`, seed: { env: `FOO=bar\n${P.openEnv[0][0]}\n` }, script: flow(P, { replace }) }), async (run) => {
        assert.ok(writeEvents(run).some((e) => e.startsWith("hermes config set")), "the mutated gate must let the write through");
      });
    });

    it("CONTROL: without the snapshot a failure after the write cannot restore the old state", async () => {
      const replace = [["snapshot ||", "true ||"]];
      mustReplace({ skill: S, ids: ["step5#1"], replace });
      await scenario(base({ name: `${P.key}-ctl-snap`, seed: { env: P.oldEnv, config: P.oldCfg }, knobs: { curl_routes: P.routes, "fail.logs": true }, env: P.inputs({ FORCE: "1" }), script: flow(P, { replace }) }), async (run) => {
        assertStateChanged(run);
        assert.notEqual(run.sb.read(".hermes/.env"), P.oldEnv);
      });
    });

    it("CONTROL: a vendor preflight that is skipped lets a rejected token reach the write", async () => {
      const text = loadBlocks(S).find((b) => b.id === "step3#2").code;
      assert.match(text, /exit 1/);
      const script = assemble(["set +e\n", { skill: S, ids: ["before-you-start#1", "step0#1", "step1#1", "step2#1", "step3#1", "step4#1", "step5#1", "step5#2", "step6#1"] }, SCRIPT_END]);
      await scenario(base({ name: `${P.key}-ctl-pre`, valid: [], script }), async (run) => {
        assert.ok(writeEvents(run).some((e) => e.startsWith("hermes config set")), "without Step 3b the writes happen even for a token the vendor would reject");
      });
    });
  });
}

// ---- platform-specific behaviour ------------------------------------------------------------------------------------
describe("platform-discord: specifics", { concurrency: 4 }, () => {
  const P = PLATFORMS[0];
  const S = P.skill;
  const rt = (flagsJson) => routes(tab("applications/@me", flagsJson));
  const run1 = (opts) => scenario({ valid: P.valid, files: { "logs.txt": P.goodLog }, script: flow(P), env: P.inputs(), ...opts, knobs: { curl_routes: P.routes, ...(opts.knobs || {}) } }, opts.check);

  it("Message Content Intent OFF (no content bit in application flags): ABORT with the Developer Portal fix, nothing written", async () => {
    for (const flags of [0, 16384, 32768, 4096]) {
      await run1({ name: "dc-intent-off", knobs: { curl_routes: rt(JSON.stringify({ id: "999999999999999999", name: "Hermes Bot", flags })) }, check: async (run) => {
        assert.equal(run.code, 1, `flags=${flags}\n${run.out}`);
        assert.match(run.out, /ABORT: .*Message Content Intent/);
        assert.match(run.out, /developers\/applications/);
        assert.match(run.out, /Nothing was written/);
        assertStateIdentical(run);
        assert.deepEqual(writeEvents(run), []);
        assert.ok(!run.sb.exists(".hermes/.hstack-backup"));
      } });
    }
  });

  it("either content bit (18 = enabled, 19 = limited) passes; the Server Members bit is not required for numeric ids", async () => {
    for (const flags of [262144, 524288, 262144 + 16384 + 32768, 8421376 + 262144]) {
      await run1({ name: "dc-intent-on", knobs: { curl_routes: rt(JSON.stringify({ id: "999999999999999999", name: "Hermes Bot", flags })) }, check: async (run) => {
        assert.equal(run.code, 0, `flags=${flags}\n${run.out}`);
        assert.ok(run.completed);
      } });
    }
  });

  it("flags unreadable: WARN that the intent could not be verified, continue (the log check still decides)", async () => {
    await run1({ name: "dc-flags-unknown", knobs: { curl_routes: rt(JSON.stringify({ id: "999999999999999999", name: "Hermes Bot" })) }, check: async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /WARN: .*could not read the application flags/);
    } });
  });

  it("prints the invite URL for the application id with the permission integer Hermes uses; the token is not in it", async () => {
    await run1({ name: "dc-invite", check: async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.out, /https:\/\/discord\.com\/oauth2\/authorize\?client_id=999999999999999999&scope=bot\+applications\.commands&permissions=309240908864&integration_type=0/);
      assertSecretsNotPrinted(run, P.secrets);
    } });
  });

  it("behaviour keys go to config.yaml through `config set discord.*`, never to .env, and only when supplied", async () => {
    await run1({ name: "dc-behaviour", env: P.inputs({ DISCORD_AUTO_THREAD: "False", DISCORD_REQUIRE_MENTION: "true" }), check: async (run) => {
      assert.equal(run.code, 0, run.out);
      const cfg = run.sb.read(".hermes/config.yaml");
      assert.match(cfg, /^discord\.auto_thread: false$/m);
      assert.match(cfg, /^discord\.require_mention: true$/m);
      const env = run.sb.read(".hermes/.env");
      assert.ok(!/AUTO_THREAD|REQUIRE_MENTION/.test(env));
      assert.ok(!/python3? .*yaml/.test(run.sb.sshCalls().join("\n")), "no hand-rolled yaml editing");
    } });
    await run1({ name: "dc-behaviour-none", check: async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(!/discord\./.test(run.sb.read(".hermes/config.yaml").replace(/platforms\.discord\.enabled/g, "")), "defaults are left alone");
    } });
  });

  it("an invalid behaviour value is refused before any ssh", async () => {
    await run1({ name: "dc-behaviour-bad", script: gateOnly(P), env: P.inputs({ DISCORD_AUTO_THREAD: "maybe" }), check: async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /ABORT: DISCORD_AUTO_THREAD must be true or false/);
      assert.equal(run.sb.sshCalls().length, 0);
    } });
  });

  it("a failing behaviour-key write rolls back (the user asked for it)", async () => {
    await run1({ name: "dc-behaviour-fail", seed: { env: P.oldEnv, config: P.oldCfg }, env: P.inputs({ FORCE: "1", DISCORD_AUTO_THREAD: "false" }), knobs: { "fail.set.discord.auto_thread": true }, check: async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /rollback: restored/);
      assertStateIdentical(run);
    } });
  });

  it("the preflight carries the Bot scheme and a User-Agent, and only /applications/@me is called", async () => {
    await run1({ name: "dc-url", check: async (run) => {
      const c = run.sb.curlCalls();
      assert.ok(c.every((x) => x.url === "https://discord.com/api/v10/applications/@me"), JSON.stringify(c.map((x) => x.url)));
      assert.ok(c.every((x) => /User-Agent: DiscordBot/.test(x.argv)), "Discord requires a DiscordBot User-Agent");
    } });
  });

  it("python3 missing: the grep/sed fallback still reads the flags and aborts on an OFF intent", async () => {
    const hide = 'command() { if [ "$1" = -v ] && [ "$2" = python3 ]; then return 1; fi; builtin command "$@"; }\n';
    const script = assemble(["set +e\n", { skill: S, ids: ["before-you-start#1", "step0#1"] }, hide, { skill: S, ids: FLOW_IDS }, SCRIPT_END]);
    await run1({ name: "dc-nopy", script, knobs: { curl_routes: rt(JSON.stringify({ id: "999999999999999999", name: "Hermes Bot", flags: 0 })) }, check: async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /Message Content Intent/);
      assert.deepEqual(writeEvents(run), []);
    } });
  });
});

describe("platform-slack: specifics", { concurrency: 4 }, () => {
  const P = PLATFORMS[1];
  const run1 = (opts) => scenario({ valid: P.valid, files: { "logs.txt": P.goodLog }, script: flow(P), env: P.inputs(), ...opts, knobs: { curl_routes: P.routes, ...(opts.knobs || {}) } }, opts.check);

  it("bot token valid but the app-level token is rejected: ABORT naming the app token, nothing written", async () => {
    await run1({ name: "sl-app-bad", valid: [SB_GOOD], check: async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: Slack apps\.connections\.open .*did not accept the app token/);
      assert.match(run.out, /connections:write/);
      assertStateIdentical(run);
      assert.deepEqual(writeEvents(run), []);
      assert.equal(run.sb.curlCalls().length, 2);
    } });
  });

  it("bot token rejected: the app token is never sent anywhere", async () => {
    await run1({ name: "sl-bot-bad", valid: [SA_GOOD], check: async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: Slack auth\.test .*did not accept the bot token/);
      assert.equal(run.sb.curlCalls().length, 1);
      assert.deepEqual(writeEvents(run), []);
    } });
  });

  it("Slack answers HTTP 200 with {\"ok\":false,\"error\":...} for a bad token: still an ABORT, with the error code shown", async () => {
    for (const [route, msg] of [["auth.test", /invalid_auth/], ["apps.connections.open", /missing_scope/]]) {
      const bad = route === "auth.test" ? JSON.stringify({ ok: false, error: "invalid_auth" }) : JSON.stringify({ ok: false, error: "missing_scope" });
      const r = route === "auth.test" ? routes(tab("auth.test", bad), tab("apps.connections.open", JSON.stringify({ ok: true, url: "wss://x" }))) : routes(tab("auth.test", JSON.stringify({ ok: true, team: "Acme", user: "hermes" })), tab("apps.connections.open", bad));
      await run1({ name: "sl-ok-false", knobs: { curl_routes: r }, check: async (run) => {
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, msg);
        assert.deepEqual(writeEvents(run), []);
        assertStateIdentical(run);
      } });
    }
  });

  it("the bot check is auth.test, the app check is apps.connections.open (POST), each with its own token on stdin", async () => {
    await run1({ name: "sl-urls", check: async (run) => {
      const c = run.sb.curlCalls();
      assert.deepEqual(c.slice(0, 2).map((x) => x.url), ["https://slack.com/api/auth.test", "https://slack.com/api/apps.connections.open"]);
      assert.deepEqual(c.slice(0, 2).map((x) => Number(x.token_len)), [SB_GOOD.length, SA_GOOD.length]);
      assert.match(c[1].argv, /-X POST/);
      assertSecretsNotPrinted(run, [SB_GOOD, SA_GOOD]);
      assert.ok(!run.out.includes("ticket="), "the single-use websocket URL must not be printed");
    } });
  });

  it("both tokens land in .env once each, the allowlist before the tokens, the app token before the bot token", async () => {
    await run1({ name: "sl-order", check: async (run) => {
      assert.equal(run.code, 0, run.out);
      const keys = writeKeys(run);
      assert.ok(keys.indexOf("SLACK_ALLOWED_USERS") < keys.indexOf("SLACK_APP_TOKEN") && keys.indexOf("SLACK_APP_TOKEN") < keys.indexOf("SLACK_BOT_TOKEN"), keys.join(","));
      const env = parseEnv(run.sb.read(".hermes/.env"));
      assert.equal(env.get("SLACK_BOT_TOKEN")[0], SB_GOOD);
      assert.equal(env.get("SLACK_APP_TOKEN")[0], SA_GOOD);
      assert.ok(!env.has("SLACK_SIGNING_SECRET"));
    } });
  });

  it("member ids may start with U or W; channel ids with C, G or D", async () => {
    await run1({ name: "sl-ids", env: P.inputs({ SLACK_ALLOWED_USERS: `${SL_ID},${SL_ID2}`, SLACK_HOME_CHANNEL: "D0123456789" }), check: async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/.env"), /^SLACK_HOME_CHANNEL=D0123456789$/m);
    } });
  });

  it("require_mention is an optional config.yaml key (`slack.require_mention`), never an env write", async () => {
    await run1({ name: "sl-mention", env: P.inputs({ SLACK_REQUIRE_MENTION: "FALSE" }), check: async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/config.yaml"), /^slack\.require_mention: false$/m);
      assert.ok(!/REQUIRE_MENTION/.test(run.sb.read(".hermes/.env")));
    } });
    await run1({ name: "sl-mention-bad", script: gateOnly(P), env: P.inputs({ SLACK_REQUIRE_MENTION: "sometimes" }), check: async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /ABORT: SLACK_REQUIRE_MENTION must be true or false/);
      assert.equal(run.sb.sshCalls().length, 0);
    } });
  });

  it("a signing secret is never asked for or written", async () => {
    await run1({ name: "sl-nosecret", check: async (run) => {
      assert.ok(!/SIGNING/i.test(run.sb.read(".hermes/.env")));
      assert.ok(!/signing secret/i.test(loadBlocks("platform-slack").map((b) => b.code).join("\n").replace(/#.*$/gm, "").replace(/echo .*$/gm, "")));
    } });
  });
});

describe("platform-mattermost: specifics", { concurrency: 4 }, () => {
  const P = PLATFORMS[2];
  const run1 = (opts) => scenario({ valid: P.valid, files: { "logs.txt": P.goodLog }, script: flow(P), env: P.inputs(), ...opts, knobs: { curl_routes: P.routes, ...(opts.knobs || {}) } }, opts.check);

  it("trailing slashes are removed before anything is written or called (Hermes does the same: adapter rstrip)", async () => {
    await run1({ name: "mm-slash", env: P.inputs({ MATTERMOST_URL: `${MM_URL}//` }), check: async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/.env"), new RegExp(`^MATTERMOST_URL=${MM_URL.replace(/[.]/g, "\\.")}$`, "m"));
      assert.ok(run.sb.curlCalls().every((c) => c.url === `${MM_URL}/api/v4/users/me`), JSON.stringify(run.sb.curlCalls().map((c) => c.url)));
    } });
  });

  it("a port and a path prefix are kept; the credential is sent as a bearer token on stdin", async () => {
    await run1({ name: "mm-port", env: P.inputs({ MATTERMOST_URL: "http://mm.example.test:8065/chat" }), check: async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(run.sb.curlCalls().every((c) => c.url === "http://mm.example.test:8065/chat/api/v4/users/me"));
      assertNoSecretInArgv(run, P.secrets);
    } });
  });

  it("the server answers but the token has no user (no id in /users/me): ABORT, nothing written", async () => {
    await run1({ name: "mm-noid", knobs: { curl_routes: routes(tab("/api/v4/users/me", JSON.stringify({ message: "nope" }))) }, check: async (run) => {
      assert.equal(run.code, 1, run.out);
      assert.match(run.out, /ABORT: Mattermost .*did not accept the token/);
      assert.deepEqual(writeEvents(run), []);
    } });
  });

  it("URL is written before the token, the allowlist first", async () => {
    await run1({ name: "mm-order", check: async (run) => {
      assert.deepEqual(writeKeys(run).filter((k) => /^[A-Z]/.test(k)), ["MATTERMOST_ALLOWED_USERS", "MATTERMOST_URL", "MATTERMOST_TOKEN"]);
    } });
  });

  it("reply mode is an optional .env value (thread|off) written before the token; anything else is refused locally", async () => {
    await run1({ name: "mm-reply", env: P.inputs({ MATTERMOST_REPLY_MODE: "Thread" }), check: async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/.env"), /^MATTERMOST_REPLY_MODE=thread$/m);
      const keys = writeKeys(run);
      assert.ok(keys.indexOf("MATTERMOST_REPLY_MODE") < keys.indexOf("MATTERMOST_TOKEN"));
    } });
    await run1({ name: "mm-reply-bad", script: gateOnly(P), env: P.inputs({ MATTERMOST_REPLY_MODE: "nested" }), check: async (run) => {
      assert.equal(run.code, 1);
      assert.match(run.out, /ABORT: MATTERMOST_REPLY_MODE must be thread or off/);
      assert.equal(run.sb.sshCalls().length, 0);
    } });
  });

  it("require_mention goes to config.yaml (`mattermost.require_mention`)", async () => {
    await run1({ name: "mm-mention", env: P.inputs({ MATTERMOST_REQUIRE_MENTION: "false" }), check: async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.match(run.sb.read(".hermes/config.yaml"), /^mattermost\.require_mention: false$/m);
    } });
  });

  it("no Docker call is made: the host install talks to the server by URL; the old container-network step is gone", async () => {
    await run1({ name: "mm-nodocker", check: async (run) => {
      assert.equal(run.sb.log("local-forbidden.log"), "");
      assert.ok(!/docker network connect|docker exec/.test(loadBlocks("platform-mattermost").map((b) => b.code).join("\n")));
    } });
  });

  it("a pairing code seen in the logs is never approved automatically", async () => {
    await run1({ name: "mm-nopair", files: { "logs.txt": P.goodLog + "x: pairing code: ABCD1234 for user abc\n" }, check: async (run) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(!run.sb.events().some((e) => /pairing approve/.test(e)));
    } });
  });
});
