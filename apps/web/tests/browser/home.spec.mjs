import { test, expect } from "@playwright/test";

test("homepage shows platforms and links to the separate integration catalog", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/hstack/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Hermes/i);
  await expect(page.locator(".platform-card")).toHaveCount(8);
  await expect(page.locator(".integrations-explorer, .tier-cloud, #integrations")).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search integrations" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Browse integrations", exact: true })).toHaveAttribute("href", "/docs/integrations");
  await expect(page.locator('a[href="#integrations"], a[href="/#integrations"]')).toHaveCount(0);

  const broken = await page.evaluate(async () => {
    const images = [...document.querySelectorAll("img[src^='/logos/']")];
    await Promise.all(images.map((img) => img.decode().catch(() => {})));
    return images.filter((img) => img.naturalWidth === 0).map((img) => img.getAttribute("src"));
  });
  expect(broken).toEqual([]);
});

test("install tabs switch the command and /builder is gone", async ({ page }) => {
  await page.goto("/");
  const install = page.getByRole("region", { name: "Install hstack" }).first();
  await install.getByRole("button", { name: "Windows" }).click();
  await expect(install.locator("code")).toContainText("install.ps1");

  const response = await page.goto("/builder");
  expect(response?.status()).toBe(404);
});

test("homepage fits a phone-width viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
