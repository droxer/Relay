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

    /* A chip that was migrated onto Badge must keep the primitive's SHAPE and
       differ only in fill, ink, or its own layout residue. Three surfaces used
       to draw their own radius, hairline, inline pad and label size; nothing
       but review memory kept them equal to the primitive afterwards, which is
       how they drifted in the first place. Geometry is compared property by
       property against a reference Badge rather than asserted as literals, so
       this test follows the primitive when it is tuned instead of pinning it. */
    test("consolidated chips keep the Badge geometry", async ({ page }) => {
      const GEOMETRY = [
        "borderRadius", "borderTopWidth",
        "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
        "fontSize", "fontWeight", "lineHeight", "height",
      ];
      const measured = await page.evaluate((props) => {
        const read = (selector: string) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const cs = getComputedStyle(el);
          return Object.fromEntries(props.map((p) => [p, cs[p as never] as string]));
        };
        return {
          reference: read(".badge-probe-ref"),
          inventory: read(".adm-agent-inventory-pill"),
          emptyTag: read(".adm-dash-empty-tag"),
          langBadge: read(".pref-lang-badge"),
        };
      }, GEOMETRY);

      expect(measured.reference).not.toBeNull();
      for (const key of ["inventory", "emptyTag", "langBadge"] as const) {
        expect(measured[key], `${key} is missing from the specimen`).not.toBeNull();
        expect(measured[key], `${key} drifted from the Badge geometry`).toEqual(measured.reference);
      }
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

    /* The menu keyboard contract. The two rail menus this primitive replaced
       implemented ArrowUp/ArrowDown and Escape by hand and implemented neither
       typeahead nor Home/End — omissions that are invisible on screen, which
       is why they want a test rather than a review. */
    test("dropdown menu carries the full menu keyboard contract", async ({ page }) => {
      const trigger = page.getByRole("button", { name: "Open menu" });
      await expect(trigger).toHaveAttribute("aria-haspopup", "menu");

      await trigger.click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");

      // Arrow keys move the highlight; Home/End jump to the ends.
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: "First action" })).toBeFocused();
      await page.keyboard.press("End");
      await expect(page.getByRole("menuitem", { name: "Destructive action" })).toBeFocused();
      await page.keyboard.press("Home");
      await expect(page.getByRole("menuitem", { name: "First action" })).toBeFocused();

      // Typeahead — the part neither hand-rolled menu had.
      await page.keyboard.type("sec");
      await expect(page.getByRole("menuitem", { name: "Second action" })).toBeFocused();

      // Escape closes and returns focus to the trigger.
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test("menu popup shares the select popup's floating surface", async ({ page }) => {
      await page.getByRole("button", { name: "Open menu" }).click();
      const menu = page.locator('[data-slot="dropdown-menu-content"]');
      const shadow = await menu.evaluate(el => getComputedStyle(el).boxShadow);
      const ring = await tokenStyle(menu, "box-shadow", "var(--shadow-2)");
      // Flat elevation: the hairline ring, never a blurred drop shadow.
      expect(shadow.replaceAll("rgba(0, 0, 0, 0) 0px 0px 0px 0px, ", "")).toBe(ring);
      await expect(menu).toHaveCSS("background-color", await tokenStyle(menu, "background-color", "var(--popover)"));
    });

    /* The splitter's `grows` prop is the one thing the shared ResizeHandle can
       get silently wrong: a panel whose arrow keys run backwards screenshots
       identically and only fails under the hand. The three shell splitters do
       not agree on direction — the rail and thread list grow rightward, the
       space panel grows leftward — so both directions are pinned here. */
    test("resize handle keyboard follows its grow direction", async ({ page }) => {
      const growsEnd = page.getByRole("separator", { name: "Grows inline-end" });
      await expect(growsEnd).toHaveAttribute("aria-valuenow", "240");
      await growsEnd.focus();
      await page.keyboard.press("ArrowRight");
      // Grows inline-end: the right arrow widens it.
      await expect(growsEnd).toHaveAttribute("aria-valuenow", "256");
      await page.keyboard.press("ArrowLeft");
      await expect(growsEnd).toHaveAttribute("aria-valuenow", "240");

      const growsStart = page.getByRole("separator", { name: "Grows inline-start" });
      await growsStart.focus();
      await page.keyboard.press("ArrowRight");
      // Grows inline-start: the SAME key narrows it. The inversion is the point.
      await expect(growsStart).toHaveAttribute("aria-valuenow", "224");

      // Home restores the default in both orientations.
      await page.keyboard.press("Home");
      await expect(growsStart).toHaveAttribute("aria-valuenow", "240");
    });

    test("resize handle exposes the splitter value contract", async ({ page }) => {
      const handle = page.getByRole("separator", { name: "Grows inline-end" });
      // A focusable separator with a value is an ARIA splitter; all three
      // readings must be present or a screen reader announces no position.
      await expect(handle).toHaveAttribute("aria-valuemin", "100");
      await expect(handle).toHaveAttribute("aria-valuemax", "400");
      await expect(handle).toHaveAttribute("aria-orientation", "vertical");
      await expect(handle).toHaveAttribute("tabindex", "0");
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
