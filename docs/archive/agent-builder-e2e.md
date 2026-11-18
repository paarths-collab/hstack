> Historical prototype report. The referenced `apps/web` builder and account APIs were removed. These results do not describe the current website; see [project history](../project-history.md).

# Agent Builder end-to-end check — 2026-09-26

## Automated path

- The Next.js production server build succeeds for `/`, `/builder/`, and the account API routes.
- `node --test tests/unit/*.test.mjs tests/compatibility/*.test.mjs tests/integration/*.test.mjs tests/generated-projects/*.test.mjs tests/stack-builder/*.mjs tests/recipes/*.mjs tests/agent-builder/*.mjs packages/agent-builder-adapters/*.test.mjs` passes **43/43** tests.
- From `apps/web`, `npm run test:e2e` passes **9/9** Chrome tests. The browser suite creates and edits workflows, selects public-page and RSS scopes, switches targets, downloads JSON and ZIP files, installs the actual browser ZIP with `plan` and `apply`, verifies it with `doctor`, uninstalls it, and imports its JSON backup.
- The account tests create users, sign in and out, save and reopen an edited workflow, create and edit an app setup note, and check that another account cannot read or change those records. The API test also rejects a token-shaped connection note and a foreign-origin write. `node --test apps/web/lib/backend.test.mjs` passes the focused server test.
- The browser suite also checks that an invalid workflow edit reports a review issue without claiming browser storage failed.
- Homepage checks cover interactive template/harness previews, navigation, a 390px viewport (including the terminal selector's bounds), animation pause and reduced motion, and carrying a selected template into the builder while retaining the previous draft and preserving later edits after reload. The hero selector also starts a blank agent with the chosen Hermes target.

## Website design and media

- The landing page uses the requested [Hermes Agent](https://hermes-agent.nousresearch.com/) visual composition: electric blue (#0000f2), thin condensed headings, centered wordmark, squared controls, and terminal-style harness selection. Product copy and links describe Agent Builder. The selected 21st.dev ASCII network appears in a blue hero card beside the headline.
- No Hermes fonts, source code, or illustration assets are included.
- Barlow Condensed 200/400 is self-hosted through `next/font/local`; the official Google Fonts files and SIL OFL license are in `apps/web/app/fonts/`.
- The user's selected [21st.dev ASCII network artwork](https://21st.dev/community/ascii/image-3267549b-67c8-4dbf-992c-eda61a71a63e) is the main hero visual. The video and still poster are publicly displayed previews hosted on `assets.21st.dev`, referenced remotely with an on-page source credit. No source code or gated export was obtained. 21st.dev's Copy prompt action required sign-in, so this artwork still depends on that external host.
- Template cards use three original static ASCII illustrations generated in a Server Component. The Framer ASCII Field, ASCII Engine, and ASCII Motion listings were inspected for visual references; no paid components were purchased or copied.
- The video pauses offscreen, provides a visible pause control, and is omitted for reduced-motion preferences. The still poster remains visible if video playback fails.
- The loaded video and working pause control were checked in the in-app browser. Desktop and mobile hero, product preview, and builder layouts were inspected visually.

## Live local smoke checks

- A generated Codex Notes-to-Tasks ZIP passed `plan`, `apply`, and `doctor` in a temporary project. `codex exec` was invoked with the installed skill selector in read-only mode against two supplied notes and returned the expected checklist with one known owner and date and one unknown owner and date.
- The generated Python 3 RSS reader fetched the [official Python Insider feed](https://blog.python.org/rss.xml) over HTTPS and returned 30 bounded items with zero errors. RSS and Atom parsing, unsafe XML rejection, private-address rejection, and missing-Python diagnosis also have automated tests.

## Current verification boundary

The website is an LLM-free exporter with a local Next.js account API. Account records persist in a SQLite database on the server; a static host can no longer run the account features. Saved app records are non-secret setup notes, not live OAuth connections. `doctor` checks generated file hashes, the target harness executable, and Python 3 when RSS is installed. It does not authenticate tools or prove that GitHub, Telegram, or a schedule works in a user's account. Claude Code was not installed on this test machine; Hermes output was installed with a simulated harness binary in the browser test. Email verification and password reset are not configured; public hosting needs those plus a durable database. Hermes schedule activation and Claude Code/Hermes workflow execution still require checks in those local environments.
