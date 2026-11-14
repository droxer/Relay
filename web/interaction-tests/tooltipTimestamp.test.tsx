import { expect, it } from "vitest";
import * as format from "../src/lib/workspaceFormat";

it.each(["en", "zh-CN", "zh-TW"])("formats full timestamp tooltip with the selected %s locale", (locale) => {
  const value = "2026-11-14T05:00:00Z";
  const title = format.timestampTitle(value, locale);
  expect(title).toContain("2026");
  expect(title).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  expect(title).not.toContain("T05:00:00Z");
  if (locale === "en") expect(title).toContain("November");
  else expect(title).toMatch(/2026年11月/);
});
it("keeps invalid diagnostic date values readable", () => {
  expect(format.timestampTitle("invalid", "en")).toBe("invalid");
  expect(format.timestampTitle(undefined, "en")).toBe("");
});
