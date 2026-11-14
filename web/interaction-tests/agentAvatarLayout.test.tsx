import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps every supported runtime glyph centered in its avatar", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve("src/styles/inputs.css"), "utf8");
  const container = document.createElement("div");
  document.head.append(style);
  document.body.append(container);
  try {
    for (const runtime of ["claude", "pi", "codex", "opencode"]) {
      const avatar = document.createElement("span");
      avatar.className = "agent-avatar";
      avatar.dataset.agent = runtime;
      avatar.innerHTML = '<svg width="20" height="20"></svg>';
      container.append(avatar);
      expect(getComputedStyle(avatar).display, runtime).toBe("grid");
      expect(getComputedStyle(avatar).placeItems, runtime).toBe("center");
    }
  } finally {
    container.remove();
    style.remove();
  }
});
