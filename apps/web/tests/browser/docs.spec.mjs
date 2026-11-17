import { test, expect } from "@playwright/test";

test("homepage links to the catalog and an integration guide", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Browse integrations", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/integrations$/);
  await expect(page.locator(".logo-tile")).toHaveCount(71);
  await page.locator('a.logo-tile[href="/docs/integrations/docs/notion"]').click();
  await expect(page).toHaveURL(/\/docs\/integrations\/docs\/notion$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Notion");
  await expect(page.locator(".breadcrumbs")).toContainText("DocsIntegrationsDocsNotion");
});

test("reader guide explains the app and copies a useful setup request", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/docs/integrations/docs/notion");
  await expect(page.locator(".reader-summary")).toContainText("pages and databases");
  await expect(page.getByRole("heading", { name: "What it does", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What you’ll need", exact: true })).toBeVisible();
  await expect(page.locator(".reader-requirements")).toContainText("pages or databases you want to share");
  await page.getByRole("button", { name: "Copy request", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Connect Notion to my Hermes server.");
  await expect(page.getByRole("link", { name: "Instructions for your coding agent" })).toHaveAttribute("href", /skills\/integration-notion\/SKILL\.md$/);
  await expect(page.locator(".viewer-tabs, .source-view, .code-block, .table-wrap")).toHaveCount(0);
});

test("core guides use task names and keep technical instructions on GitHub", async ({ page }) => {
  await page.goto("/docs/core/blueprint-install");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Install a blueprint");
  await expect(page.locator(".reader-summary")).toContainText("reviewed plan");
  await expect(page.getByRole("link", { name: "Instructions for your coding agent" })).toHaveAttribute("href", /skills\/blueprint-install\/SKILL\.md$/);
  await expect(page.getByRole("tab")).toHaveCount(0);
});

test("every docs section page and an unknown skill", async ({ page }) => {
  for (const [path, heading] of [["/docs", "HSTACK docs"], ["/docs/how-it-works", "How it works"], ["/docs/core", "Core skills"], ["/docs/platforms", "Platforms"], ["/docs/integrations", "Integrations"], ["/docs/integrations/cloud", "Cloud"]]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  }
  await expect(page.locator(".doc-cards li")).toHaveCount(10);
  expect((await page.goto("/docs/integrations/cloud/notion"))?.status()).toBe(404);
  expect((await page.goto("/docs/platforms/myspace"))?.status()).toBe(404);
});

test("docs sidebar search narrows the list", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs");
  const sidebar = page.locator(".docs-sidebar-wrap");
  await sidebar.getByRole("searchbox", { name: "Filter docs" }).fill("stripe");
  await expect(sidebar.locator("li a")).toHaveText(["Stripe"]);
});

test("docs pages fit a phone-width viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/docs", "/docs/how-it-works", "/docs/platforms/telegram", "/docs/integrations", "/docs/integrations/vector/pinecone", "/docs/core/blueprint-saas-founder"]) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), path).toBeLessThanOrEqual(0);
  }
});

test("docs overview offers installation and keyboard-expandable navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs");
  const install = page.getByRole("region", { name: "Install hstack" });
  await install.getByRole("button", { name: "Windows" }).click();
  await expect(install.locator("code")).toContainText("install.ps1");
  const sidebar = page.locator(".docs-sidebar-wrap");
  const core = sidebar.locator(".docs-nav-group").filter({ has: page.locator("summary", { hasText: "Core skills" }) });
  await core.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(core).toHaveAttribute("open", "");
  await core.getByRole("link", { name: "Check your agent", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your agent");
  await sidebar.getByRole("searchbox", { name: "Filter docs" }).fill("no-such-skill");
  await expect(sidebar.getByRole("status")).toContainText("No skills found");
});

test("mobile docs search navigates and closes the browse panel", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/docs");
  const drawer = page.locator(".docs-sidebar-mobile");
  await drawer.locator(":scope > summary").click();
  await drawer.getByRole("searchbox", { name: "Filter docs" }).fill("stripe");
  await drawer.getByRole("link", { name: "Stripe", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stripe");
  await expect(drawer).not.toHaveAttribute("open");
  await page.getByRole("link", { name: "hstack home", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hermes");
  await expect(page.locator(".site-header-compact")).toHaveCount(0);
});

test("a section link opens the guide at its setup instructions", async ({ page }) => {
  await page.goto("/docs/integrations/docs/notion#get-started");
  await expect.poll(() => page.locator("#get-started").evaluate(el => Math.round(el.getBoundingClientRect().top))).toBeLessThan(400);
});

test("catalog shows a short description and a loaded logo for every app", async ({ page }) => {
  await page.goto("/docs/integrations");
  await expect(page.locator(".logo-tile")).toHaveCount(71);
  await expect(page.locator(".logo-tile-summary")).toHaveCount(71);
  expect(await page.locator(".logo-tile-summary").evaluateAll(items => items.every(item => item.textContent.length > 20))).toBe(true);
  await expect(page.locator(".integrations-count")).toHaveText("71 of 71 integrations");
  await expect(page.locator(".logo-tile code, .tier-head code")).toHaveCount(0);
  const broken = await page.locator(".integrations-explorer").evaluate(async root => {
    const images = [...root.querySelectorAll("img")];
    await Promise.all(images.map(img => img.decode().catch(() => {})));
    return images.filter(img => !img.naturalWidth).map(img => img.getAttribute("src"));
  });
  expect(broken).toEqual([]);
});

test("category buttons filter integrations on desktop and mobile without a search bar", async ({ page }) => {
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/docs/integrations");
    const categories = page.getByRole("group", { name: "Filter integrations by category" });
    await expect(categories.getByRole("button")).toHaveCount(21);
    await expect(page.locator(".integrations-explorer input, .integrations-explorer select")).toHaveCount(0);
    await categories.getByRole("button", { name: "Memory", exact: true }).click();
    await expect(page.locator(".logo-tile-name")).toHaveText(["mem0", "Supermemory"]);
    await expect(categories.getByRole("button", { pressed: true })).toHaveText("Memory");
    await expect(page.locator(".integrations-count")).toHaveText("2 of 71 integrations");
    await categories.getByRole("button", { name: "Docs", exact: true }).click();
    await expect(page.locator(".logo-tile-name")).toHaveText(["Notion", "Google Workspace", "Microsoft 365", "Obsidian"]);
    await categories.getByRole("button", { name: "All", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".logo-tile")).toHaveCount(71);
    await expect(categories.getByRole("button", { pressed: true })).toHaveText("All");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  }
});

test("Pinecone explains its actual scope without exposing the agent runbook", async ({ page }) => {
  await page.goto("/docs/integrations/vector/pinecone");
  await expect(page.locator(".reader-summary")).toContainText("read-only");
  await expect(page.locator(".reader-scope")).toContainText("does not provide vector search");
  await expect(page.locator(".reader-compatibility")).toContainText("live connection testing is still pending");
  await expect(page.locator(".reader-guide pre, .reader-guide code, .viewer-tabs, .table-wrap")).toHaveCount(0);
});
