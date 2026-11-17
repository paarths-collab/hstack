import { test, expect } from "@playwright/test";

test("Docs beside the wordmark opens the docs overview and HSTACK opens home", async ({ page }) => {
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/docs/integrations/vector/pinecone");
    const header = page.locator(".site-header");
    await header.getByRole("link", { name: "Docs overview", exact: true }).click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("HSTACK docs");
    await header.getByRole("link", { name: "hstack home", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Hermes");
  }
});

test("desktop and mobile header navigation opens the matching pages and installation section", async ({ page }) => {
  const destinations = [
    ["Platforms", "/docs/platforms", "Platforms"],
    ["Integrations", "/docs/integrations", "Integrations"],
    ["How it works", "/docs/how-it-works", "How it works"],
    ["Docs", "/docs", "HSTACK docs"],
  ];
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const header = page.locator(".site-header");
    const nav = width < 760 ? header.locator(".site-mobile-nav") : header.locator(".header-inner");
    for (const [name, path, title] of destinations) {
      if (width < 760) await header.getByRole("button", { name: "Open menu" }).click();
      await nav.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      if (width < 760) await expect(nav).toBeHidden();
    }
    if (width < 760) await header.getByRole("button", { name: "Open menu" }).click();
    await nav.getByRole("link", { name: "Install HSTACK", exact: true }).click();
    await expect(page).toHaveURL(/\/#install$/);
    await expect.poll(() => page.locator("#install").evaluate(el => Math.abs(el.getBoundingClientRect().top - 90))).toBeLessThan(5);
  }
});

test("footer catalog links open catalogs and installation links land on the right instructions", async ({ page }) => {
  for (const [name, path, title] of [["Platforms", "/docs/platforms", "Platforms"], ["Integrations", "/docs/integrations", "Integrations"], ["Core skills", "/docs/core", "Core skills"]]) {
    await page.goto("/");
    await page.locator(".site-footer").getByRole("navigation", { name: "Catalog", exact: true }).getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  }
  for (const [name, id] of [["macOS & Linux", "install-unix"], ["Windows", "install-windows"], ["Coding agents", "agents"]]) {
    await page.goto("/");
    await page.locator(".site-footer").getByRole("navigation", { name: "Install", exact: true }).getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/#${id}$`));
    await expect.poll(() => page.locator(`#${id}`).evaluate(el => Math.abs(el.getBoundingClientRect().top - 90))).toBeLessThan(5);
  }
});
