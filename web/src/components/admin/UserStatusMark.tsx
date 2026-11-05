"use client";

import type { TFunction } from "i18next";
import { userSummaryStatus, type UserNodeSummary } from "./helpers";
import { TonePill } from "../StatusPill";

/**
 * A user's fleet state, named only when a computer chip cannot say it: work
 * in flight, or a machine that needs attention. Ready, idle, and "no
 * computers" are already read off the chips, so they draw nothing. Dot +
 * word, no tinted slab — the same drawing on the card and the list row.
 */
export function UserStatusMark({ member, t }: { member: UserNodeSummary; t: TFunction }) {
  const { tone, key } = userSummaryStatus(member);
  if (key !== "running" && key !== "failed") return null;
  return (
    <TonePill
      className="adm-status-plain"
      tone={tone}
      label={t(`admin.v2.emp_state_${key}`, { defaultValue: key })}
      live={tone === "info"}
    />
  );
}
