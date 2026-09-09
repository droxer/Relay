import { expect, test, type Locator } from "@playwright/test";

// Resolve the expected token through the browser in the consumer's scope.
async function tokenStyle(locator: Locator, property: string, value: string) {
  return locator.evaluate((element, { property, value }) => {
    const probe = document.createElement("span");
    const styles = getComputedStyle(element);
    for (const name of styles) {
      if (name.startsWith("--")) probe.style.setProperty(name, styles.getPropertyValue(name));
    }
    probe.style.setProperty(property, value);
    // Inputs are void elements; probes must be siblings to participate in layout.
    element.parentElement!.appendChild(probe);
    const result = getComputedStyle(probe).getPropertyValue(property);
    probe.remove();
    return result;
  }, { property, value });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(theme, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/dev/design-system");
      await page.getByRole("button", { name: `${theme === "light" ? "Light" : "Dark"} theme` }).click();
    });

    test("select and checked switch retain their control chrome", async ({ page }) => {
      const select = page.getByRole("combobox", { name: "Page select", exact: true });
      await expect(select).toHaveCSS("border-top-style", "solid");
      expect(parseFloat(await select.evaluate(el => getComputedStyle(el).borderTopWidth))).toBeGreaterThan(0);
      const control = page.getByRole("switch", { name: "Example switch" });
      await control.click();
      await expect(control).toBeChecked();
      await expect(control).toHaveCSS("background-color", await tokenStyle(control, "background-color", "var(--action)"));
    });

    test("status edges resolve each component's tone", async ({ page }) => {
      for (const [id, tone] of [["warning-badge", "--warn"], ["error-badge", "--err"], ["live-badge", "--live"]]) {
        const badge = page.getByTestId(id);
        await expect(badge).toHaveCSS("border-top-color", await tokenStyle(badge, "border-top-color", `color-mix(in srgb, var(${tone}) 35%, transparent)`));
      }
      const alert = page.getByRole("alert").filter({ hasText: "Unable to save" });
      await expect(alert).toHaveCSS("border-top-color", await tokenStyle(alert, "border-top-color", "color-mix(in srgb, var(--err) 35%, transparent)"));
    });

    test("drawer fields preserve control and invalid borders", async ({ page }) => {
      await page.getByRole("button", { name: "Open drawer" }).click();
      const field = page.getByRole("textbox", { name: "Overlay input", exact: true });
      await expect(field).toHaveCSS("border-top-color", await tokenStyle(field, "border-top-color", "var(--control-border)"));
      const invalid = page.getByRole("textbox", { name: "Invalid overlay input" });
      await expect(invalid).toHaveCSS("border-top-color", await tokenStyle(invalid, "border-top-color", "var(--err)"));
    });

    test("prompt fields keep the shared field border and keyboard focus", async ({ page }) => {
      await page.getByRole("button", { name: "Open prompt" }).click();
      const field = page.getByRole("textbox", { name: "Example prompt" });
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("Draft");
      expect(await field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 5]);
      await expect(field).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Tab");
      await expect(field).toHaveCSS("border-top-color", await tokenStyle(field, "border-top-color", "var(--control-border)"));
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Open prompt" })).toBeFocused();
    });

    test("switch track keeps its geometry on touch", async ({ page }, testInfo) => {
      const control = page.getByRole("switch", { name: "Example switch" });
      await expect(control).toHaveCSS("height", "20px");
      await expect(control).toHaveCSS("width", "36px");
      const target = await control.evaluate(el => {
        const track = getComputedStyle(el);
        const hit = getComputedStyle(el, "::after");
        return { width: parseFloat(track.width) - parseFloat(hit.left) - parseFloat(hit.right), height: parseFloat(track.height) - parseFloat(hit.top) - parseFloat(hit.bottom) };
      });
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: testInfo.outputPath("specimen.png"), fullPage: true });
    });

    test("disabled controls use the shared opacity", async ({ page }) => {
      for (const control of [page.getByRole("button", { name: "Disabled action" }), page.getByRole("textbox", { name: "Disabled input" })]) {
        await expect(control).toHaveCSS("opacity", await tokenStyle(control, "opacity", "var(--opacity-disabled)"));
      }
    });

    test("small controls have matching heights", async ({ page }) => {
      const button = page.getByRole("button", { name: "Small button" });
      const select = page.getByRole("combobox", { name: "Small select" });
      await expect(button).toHaveCSS("height", await select.evaluate(el => getComputedStyle(el).height));
    });

    test("toast uses floating surface and motion roles", async ({ page }) => {
      await page.getByRole("button", { name: "Show toast" }).click();
      const toast = page.locator('[data-slot="toast"]').first();
      await expect(toast).toBeVisible();
      const shadow = await toast.evaluate(el => getComputedStyle(el).boxShadow);
      const ring = await tokenStyle(toast, "box-shadow", "var(--shadow-2)");
      // Tailwind prepends zero-size transparent ring slots; only the visible
      // shadow must equal the shared ring, with no additional blurred layers.
      expect(shadow.replaceAll("rgba(0, 0, 0, 0) 0px 0px 0px 0px, ", "")).toBe(ring);
      await expect(toast).toHaveCSS("transition-duration", "0.25s, 0.25s, 0.15s");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await toast.evaluate(el => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThan(0.001);
    });
  });
}
