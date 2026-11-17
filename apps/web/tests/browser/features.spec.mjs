import { test, expect } from "@playwright/test";

test("feature cards scroll horizontally with buttons and keyboard at every screen size", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [1440, 834, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#features");
    const track = page.getByRole("region", { name: "Scrollable features" });
    await expect(track.locator(".feature-slide")).toHaveCount(6);
    // Browser history can restore a nested scroll position after resizing.
    await track.focus();
    await page.keyboard.press("Home");
    await expect(page.locator(".feature-position")).toHaveText("1 / 6");
    await expect(page.getByRole("button", { name: "Previous feature", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Next feature", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Next feature", exact: true }).click();
    await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
    await page.getByRole("button", { name: "Previous feature", exact: true }).click();
    await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeLessThan(3);

    await track.focus();
    await page.keyboard.press("End");
    await expect(page.getByRole("button", { name: "Next feature", exact: true })).toBeDisabled();
    await expect(page.locator(".feature-position")).toContainText("6");
    await page.keyboard.press("Home");
    await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeLessThan(3);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeLessThan(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  }
});

test("reduced-motion fallback supports horizontal wheel gestures and native vertical scrolling", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/#features");
  const track = page.getByRole("region", { name: "Scrollable features" });
  await track.hover();
  const top = await page.evaluate(() => scrollY);
  await page.mouse.wheel(1300, 0);
  await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
  expect(await page.evaluate(() => scrollY)).toBe(top);
  await expect.poll(() => track.evaluate(element => Math.abs(element.scrollLeft - (element.children[1].offsetLeft - element.children[0].offsetLeft)))).toBeLessThan(3);
  const horizontal = await track.evaluate(element => element.scrollLeft);
  await page.mouse.wheel(0, 350);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(top + 100);
  expect(await track.evaluate(element => element.scrollLeft)).toBe(horizontal);
});

test("scrolling down pins Features, moves panels sideways, then releases the page", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const [width, height] of [[1440, 900], [1440, 768], [834, 900], [375, 900]]) {
    await page.setViewportSize({ width, height });
    await page.goto("/#features");
    const scene = page.locator(".feature-scene");
    const pin = page.locator(".feature-pin");
    const track = page.getByRole("region", { name: "Scrollable features" });
    await expect(scene).toHaveAttribute("data-scroll-driven", "true");
    const bounds = await scene.evaluate(element => {
      const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h"));
      return { start: element.getBoundingClientRect().top + scrollY - header, distance: parseFloat(element.style.getPropertyValue("--feature-distance")), header };
    });
    await page.evaluate(start => scrollTo({ top: start + 1, behavior: "instant" }), bounds.start);
    await page.mouse.move(width / 2, Math.min(400, height / 2));
    await page.mouse.wheel(0, 450);
    await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeGreaterThan(100);
    await expect.poll(() => pin.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(bounds.header);

    await page.evaluate(({ start, distance }) => scrollTo({ top: start + distance, behavior: "instant" }), bounds);
    await expect.poll(() => track.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBeLessThan(3);
    await expect(page.locator(".feature-position")).toHaveText("6 / 6");
    await page.evaluate(({ start, distance }) => scrollTo({ top: start + distance + 400, behavior: "instant" }), bounds);
    await expect.poll(() => pin.evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(bounds.header - 100);
    expect(await page.locator("#core").evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(height);

    await page.evaluate(({ start, distance }) => scrollTo({ top: start + distance / 2, behavior: "instant" }), bounds);
    const overflow = await track.evaluate(element => element.scrollWidth - element.clientWidth);
    await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeCloseTo(overflow / 2, -1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  }
});
