"use client";

import type { TFunction } from "i18next";
import {
  isOverLocalComputerLimit,
  localComputerUsageLabel,
  taskCapacityOf,
  type UserNodeSummary,
} from "./helpers";
import { TonePill } from "../StatusPill";

/**
 * The user card's limits band, as a short ledger: label left, value right.
 *
 * The personal computer limit always shows — it is the one limit whose usage
 * changes. Task capacity shows only when it is pinned for this user: the org
 * default printed identically on every card was noise, and the edit drawer
 * still shows it. A pinned value says so; the default stays unmarked.
 */
export function UserLimits({ member, t }: { member: UserNodeSummary; t: TFunction }) {
  const over = isOverLocalComputerLimit(member);
  const limit = member.effectiveMaxLocalComputers;
  return (
    <dl className="adm-emp-limit-rows">
      <div className="adm-emp-limit" data-over={over ? "true" : undefined}>
        <dt className="adm-emp-limit-label">{t("admin.v2.emp_card_computers")}</dt>
        <dd className="adm-emp-limit-value">
          {member.maxLocalComputers != null ? <CustomMark t={t} /> : null}
          {/* Hue alone can't say "over" — a red count and a red pill read
              the same at a glance — so the pill carries a word. */}
          {over ? (
            <TonePill
              tone="bad"
              label={t("admin.v2.emp_limit_over_short")}
              title={t("admin.v2.emp_limit_over")}
            />
          ) : null}
          <span className="tnum">
            {limit === undefined
              ? localComputerUsageLabel(member)
              : t("admin.v2.emp_card_computers_value", { used: member.localComputerCount, limit })}
          </span>
        </dd>
      </div>
      {member.maxConcurrentTasks != null ? (
        <div className="adm-emp-limit">
          <dt className="adm-emp-limit-label">{t("admin.v2.emp_card_tasks")}</dt>
          <dd className="adm-emp-limit-value">
            <CustomMark t={t} />
            <span className="tnum">{t("admin.v2.emp_card_tasks_value", { count: taskCapacityOf(member) })}</span>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function CustomMark({ t }: { t: TFunction }) {
  return (
    <span className="adm-emp-limit-custom" title={t("admin.v2.emp_card_custom_hint")}>
      {t("admin.v2.emp_card_custom")}
    </span>
  );
}
