import type { TFunction } from "i18next";

/** The everyday questions an owner opens a Project Lead discussion with. */
export const PROJECT_LEAD_TOPICS = ["update", "attention", "next", "plan"] as const;
export type ProjectLeadTopic = (typeof PROJECT_LEAD_TOPICS)[number];

/** How far back "Project update" looks: one working week. */
export const PROJECT_UPDATE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function projectLeadTopicLabel(t: TFunction, topic: ProjectLeadTopic): string {
  return t(`project_manager.quick_${topic}`);
}

/** The message a topic puts in the composer. It is only a draft: the person
 *  reads and sends it, so nothing reaches the lead without their say. */
export function projectLeadTopicPrompt(
  t: TFunction,
  topic: ProjectLeadTopic,
  now: Date = new Date(),
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  if (topic !== "update") return t(`project_manager.prompt_${topic}`);
  const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return t("project_manager.prompt_update", {
    since: day(new Date(now.getTime() - PROJECT_UPDATE_WINDOW_DAYS * DAY_MS)),
    until: day(now),
    timezone: timeZone,
  });
}
