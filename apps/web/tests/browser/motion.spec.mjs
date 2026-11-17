import { test, expect } from "@playwright/test";

test("feature cards animate into view once and stay readable after scrolling back", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    window.revealRecordings = new WeakMap();
    Element.prototype.animate = function (frames, options) {
      if (this.hasAttribute("data-reveal")) {
        const previous = window.revealRecordings.get(this);
        window.revealRecordings.set(this, { frames, count: (previous?.count || 0) + 1 });
      }
      return animate.call(this, frames, options);
    };
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [1440, 834, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const card = page.locator(".feature-slide").first();
    await expect(page.locator(".feature-slide")).toHaveCount(6);
    await card.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "center" }));
    await expect.poll(() => card.evaluate(element => window.revealRecordings.get(element)?.count || 0)).toBe(1);
    const frames = await card.evaluate(element => window.revealRecordings.get(element).frames);
    expect(frames[0].opacity).toBe(0);
    expect(frames[0].rotate).not.toBe("0deg");
    await expect(card).toHaveAttribute("data-reveal-state", "visible");
    await expect(card).toHaveCSS("opacity", "1");
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await card.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "center" }));
    expect(await card.evaluate(element => element.getAnimations().length)).toBe(0);
    expect(await card.evaluate(element => window.revealRecordings.get(element).count)).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    const clippedPlatforms = await page.locator('.feature-art[aria-label="8 messaging platforms"]').evaluate(art => {
      const box = art.getBoundingClientRect();
      return [...art.querySelectorAll(".platform-card")].filter(card => card.getBoundingClientRect().bottom > box.bottom).length;
    });
    expect(clippedPlatforms).toBe(0);
  }
  expect(errors).toEqual([]);
});

test("reduced motion keeps content visible and cancels an entrance already playing", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const card = page.locator(".feature-slide").first();
  await card.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "center" }));
  await expect(card).toHaveCSS("opacity", "1");
  expect(await page.locator("[data-reveal]").evaluateAll(items => items.flatMap(element => element.getAnimations()).length)).toBe(0);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(card).toHaveAttribute("data-reveal-state", "entering");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(card).toHaveAttribute("data-reveal-state", "visible");
  await expect(card).toHaveCSS("opacity", "1");
  expect(await card.evaluate(element => element.getAnimations().length)).toBe(0);
});

test("keyboard focus makes an entering card immediately readable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/docs/integrations");
  await page.getByRole("group", { name: "Filter integrations by category" }).getByRole("button", { name: "Vector", exact: true }).click();
  const vector = page.locator('.tier-block[aria-labelledby="tier-vector"] li').first();
  await vector.evaluate(element => element.scrollIntoView({ behavior: "instant", block: "center" }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(vector).toHaveAttribute("data-reveal-state", "entering");
  await page.keyboard.press("Shift");
  await vector.locator("a").focus();
  await expect(vector).toHaveAttribute("data-reveal-state", "visible");
  await expect(vector).toHaveCSS("opacity", "1");
  expect(await vector.evaluate(element => element.getAnimations().length)).toBe(0);
});

test("homepage and guides remain visible with JavaScript disabled", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}/`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.locator(".feature-slide").first().scrollIntoViewIfNeeded();
    await expect(page.locator(".feature-slide").first()).toHaveCSS("opacity", "1");
    await page.locator('.platform-card[href="/docs/platforms/telegram"]').click();
    await expect(page).toHaveURL(/\/docs\/platforms\/telegram$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Telegram");
    await expect(page.locator(".reader-hero")).toHaveCSS("opacity", "1");
  } finally {
    await context.close();
  }
});
