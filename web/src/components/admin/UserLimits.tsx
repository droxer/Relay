"use client";

import type { TFunction } from "i18next";
import {
  isOverLocalComputerLimit,
  localComputerSlots,
  localComputerUsageLabel,
  taskCapacityOf,
  type UserNodeSummary,
} from "./helpers";
import { TonePill } from "../StatusPill";

/**
 * The user card's limits band: concurrent task capacity and the personal
 * computer limit, as a short ledger.
 *
 * One row each, label left and value right, so the two read as a pair of
 * facts rather than the run-on "Task capacity 5 Local limit 1/3" the footer
 * used to be.
 * The computer limit also draws its slots — used, free, and over — because
 * "1/3" asks the reader to do the subtraction the meter shows. A limit pinned
 * for this user says so; following the org default stays unmarked, since
 * that is the common case.
 */
export function UserLimits({ member, t }: { member: UserNodeSummary; t: TFunction }) {
  const over = isOverLocalComputerLimit(member);
  const slots = localComputerSlots(member);
  const limit = member.effectiveMaxLocalComputers;
  return (
    <div className="adm-emp-limits">
      <dl className="adm-emp-limit-rows">
        <div className="adm-emp-limit">
          <dt className="adm-emp-limit-label">{t("admin.v2.emp_card_tasks")}</dt>
          <dd className="adm-emp-limit-value">
            {member.maxConcurrentTasks != null ? <CustomMark t={t} /> : null}
            <span className="tnum">{t("admin.v2.emp_card_tasks_value", { count: taskCapacityOf(member) })}</span>
          </dd>
        </div>
        <div className="adm-emp-limit" data-over={over ? "true" : undefined}>
          <dt className="adm-emp-limit-label">{t("admin.v2.emp_card_computers")}</dt>
          <dd className="adm-emp-limit-value">
            {/* The number keeps the right edge so it lines up with the one
                above; qualifiers read leftward from it. */}
            {member.maxLocalComputers != null ? <CustomMark t={t} /> : null}
            {slots ? (
              <span className="adm-emp-slots" aria-hidden="true">
                {slots.map((slot, index) => (
                  <span key={index} className="adm-emp-slot" data-slot-state={slot} />
                ))}
              </span>
            ) : null}
            <span className="tnum">
              {limit === undefined
                ? localComputerUsageLabel(member)
                : t("admin.v2.emp_card_computers_value", { used: member.localComputerCount, limit })}
            </span>
          </dd>
        </div>
      </dl>
      {/* Hue alone can't say "over" — a red count and a red pill read the
          same at a glance — so the pill carries a word. */}
      {over ? (
        <p className="adm-emp-limit-note">
          <TonePill
            tone="bad"
            label={t("admin.v2.emp_limit_over_short")}
            title={t("admin.v2.emp_limit_over")}
          />
        </p>
      ) : null}
    </div>
  );
}

function CustomMark({ t }: { t: TFunction }) {
  return (
    <span className="adm-emp-limit-custom" title={t("admin.v2.emp_card_custom_hint")}>
      {t("admin.v2.emp_card_custom")}
    </span>
  );
}
