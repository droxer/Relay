import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TFunction } from "i18next";

import { PROJECT_LEAD_TOPICS, projectLeadTopicLabel, projectLeadTopicPrompt } from "../src/lib/projectLeadTopics.js";

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key) as unknown as TFunction;

describe("projectLeadTopics", () => {
  it("offers the four everyday topics in a stable order", () => {
    assert.deepEqual([...PROJECT_LEAD_TOPICS], ["update", "attention", "next", "plan"]);
    assert.equal(projectLeadTopicLabel(t, "next"), "project_manager.quick_next");
  });

  it("uses the topic's own prompt for questions that need no dates", () => {
    assert.equal(projectLeadTopicPrompt(t, "attention"), "project_manager.prompt_attention");
    assert.equal(projectLeadTopicPrompt(t, "plan"), "project_manager.prompt_plan");
  });

  it("asks for the last seven days in the viewer's timezone", () => {
    const prompt = projectLeadTopicPrompt(t, "update", new Date("2026-11-07T02:00:00Z"), "Asia/Shanghai");
    assert.equal(prompt, `project_manager.prompt_update ${JSON.stringify({ since: "2026-10-31", until: "2026-11-07", timezone: "Asia/Shanghai" })}`);
  });

  it("names the day by the viewer's calendar, not UTC's", () => {
    const prompt = projectLeadTopicPrompt(t, "update", new Date("2026-11-07T02:00:00Z"), "America/Los_Angeles");
    assert.match(prompt, /"until":"2026-11-06"/);
  });
});
