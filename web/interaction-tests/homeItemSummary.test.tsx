import { expect, it } from "vitest";
import { homeItemSummary } from "../src/lib/homeItemSummary";

it("keeps the short heading of an automation prompt", () => {
  expect(homeItemSummary("# 每日进展\n每天总结 Relay 项目的开发进展与任务看板状态。\n## 1. 开发进展\n读取仓库与 PR。")).toBe("每日进展");
});

it("omits inline prompt sections and trigger metadata", () => {
  expect(homeItemSummary("每日进展 每天总结 Relay 项目，形成日报。 ## 1. 开发进展 按窗口统计")).toBe("每日进展 每天总结 Relay 项目，形成日报。");
  expect(homeItemSummary("Cleanup Branches Prune merged branches --- Trigger context Fired by: Schedule")).toBe("Cleanup Branches Prune merged branches");
});

it("preserves ordinary task titles and shortens unstructured goals", () => {
  expect(homeItemSummary("Fix v1.2 export for example.com")).toBe("Fix v1.2 export for example.com");
  expect(homeItemSummary("a".repeat(150))).toBe("a".repeat(99) + "…");
  expect(homeItemSummary("  Choose a plan  ")).toBe("Choose a plan");
});
