"use client";

import { useTranslation } from "react-i18next";
import { SectionNav, type SectionNavItem } from "../SectionNav";
import {
  ActionCalendar,
  ActionStart,
  AdminInbox,
  IdentityUser,
  NavBacklog,
  StatusError,
  StatusOk,
} from "../icons";
import { ISSUE_QUEUES, type IssueQueue } from "../../lib/issueQueues";

/* Queues are destinations a triager works through, not states of one record,
   so they lead with a glyph rather than a status mark. */
const QUEUE_ICONS = {
  needs_me: IdentityUser,
  untriaged: AdminInbox,
  blocked: StatusError,
  running: ActionStart,
  overdue: ActionCalendar,
  open: NavBacklog,
  done: StatusOk,
} satisfies Record<IssueQueue, SectionNavItem<IssueQueue>["Icon"]>;

/** The Issues rail: one row per queue, each with its count under the filters. */
export function IssueQueueNav({ value, counts, onChange }: {
  value: IssueQueue;
  counts: Record<IssueQueue, number>;
  onChange: (queue: IssueQueue) => void;
}) {
  const { t } = useTranslation();
  const items: SectionNavItem<IssueQueue>[] = ISSUE_QUEUES.map((queue) => ({
    id: queue,
    label: t(`issues.queues.${queue}`),
    Icon: QUEUE_ICONS[queue],
    count: counts[queue],
  }));
  return <SectionNav items={items} value={value} onChange={onChange} label={t("issues.queues_label")} />;
}
