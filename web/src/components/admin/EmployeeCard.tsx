"use client";

import { employeeHandleOf } from "../../lib/employeeHandle";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import {
  ActionEdit,
  AdminDelete,
  AdminEmployees,
  ICON,
} from "../icons";
import {
  employeeSummaryStatus,
  isOverLocalComputerLimit,
  localComputerUsageLabel,
  nodeOwnershipProfile,
  type EmployeeNodeSummary,
} from "./helpers";
import { EmployeeComputers } from "./EmployeeComputers";
import { TonePill } from "../StatusPill";

interface EmployeeCardProps {
  member: EmployeeNodeSummary;
  highlight: boolean;
  onDelete?: (employeeId: string) => void;
  onEdit?: (employeeId: string) => void;
  deletePending: boolean;
  t: TFunction;
}

export function EmployeeCard({
  member,
  highlight,
  onDelete,
  onEdit,
  deletePending,
  t,
}: EmployeeCardProps) {
  const { tone, key } = employeeSummaryStatus(member);
  return (
    <article
      className={`adm-node-card adm-emp-card tone-${tone}${highlight ? " is-pulse" : ""}`}
      data-employee={member.id}
    >
      <header className="adm-node-card-head">
        <span className="adm-node-avatar adm-emp-avatar" aria-hidden="true" translate="no">
          <AdminEmployees size={ICON.lg} aria-hidden="true" />
        </span>
        <div className="adm-node-card-identity">
          <span className="adm-node-card-name" translate="no">{member.displayName}</span>
          <span className="adm-node-card-handle code" translate="no">@{employeeHandleOf(member)}</span>
          {/* Department belongs to identity, not to status. Sharing the status
              column meant it rendered on line 1 when the pill was absent and
              line 2 when it was present, so the same card component produced
              three different header layouts across one roster. */}
          {member.departmentName ? (
            <span className="adm-emp-card-dept">{member.departmentName}</span>
          ) : null}
        </div>
        <div className="adm-node-card-meta-col">
          {/* "Ready" is the default healthy state — the good tone on the card
              already carries it; only running / idle / no-nodes get named. */}
          {key !== "ready" ? (
            <TonePill
              tone={tone}
              label={t(`admin.v2.emp_state_${key}`, { defaultValue: key })}
              live={tone === "info"}
            />
          ) : null}
        </div>
      </header>

      <div className="adm-node-card-body">
        {member.email ? (
          <p className="adm-emp-card-email code ink-dim" translate="no">{member.email}</p>
        ) : null}
        <div className="adm-agents adm-emp-nodes">
          <EmployeeComputers
            nodes={member.nodes.filter((node) => nodeOwnershipProfile(node) === "local")}
            t={t}
          />
        </div>
      </div>

      <footer className="adm-node-card-foot">
        <div
          className="adm-emp-card-metrics"
          aria-label={t("admin.v2.emp_metrics_aria", {
            running: member.runningCount,
            ready: member.readyCount,
            total: member.nodeCount,
          })}
        >
          <span className="adm-emp-card-metric">
            <span className="adm-emp-metric-label">{t("admin.v2.col_running")}</span>
            <span className={`tnum ${member.runningCount > 0 ? "ink-strong" : "ink-dim"}`}>
              {member.runningCount}
            </span>
          </span>
          <span className="adm-emp-card-metric">
            <span className="adm-emp-metric-label">{t("admin.v2.col_ready")}</span>
            <span className="tnum ink-dim">{member.readyCount}/{member.nodeCount}</span>
          </span>
          <span className="adm-emp-card-metric">
            <span className="adm-emp-metric-label">{t("admin.v2.col_local_limit")}</span>
            <span className={`tnum ${isOverLocalComputerLimit(member) ? "" : "ink-dim"}`}>
              {localComputerUsageLabel(member)}
            </span>
            {/* Hue alone can't say "over" — a red count and a red pill read
                the same at a glance — so the pill carries a word, like every
                other state on this card. */}
            {isOverLocalComputerLimit(member) ? (
              <TonePill
                tone="bad"
                label={t("admin.v2.emp_limit_over_short")}
                title={t("admin.v2.emp_limit_over")}
              />
            ) : null}
          </span>
        </div>
        {onDelete || onEdit ? (
          <div className="adm-node-card-actions">
            {onEdit ? (
              <Button
                variant="icon"
                size="icon-dense"
                tinted
                type="button"
                className="adm-node-card-icon-btn"
                onClick={() => onEdit(member.id)}
                tooltip={t("admin.v2.edit_employee_action")}
              >
                <ActionEdit size={ICON.sm} aria-hidden="true" />
              </Button>
            ) : null}
            {onDelete ? (
            <Button
              variant="icon"
              size="icon-dense"
              tinted
              type="button"
              danger
              className="adm-node-card-icon-btn"
              onClick={() => onDelete(member.id)}
              disabled={deletePending}
              tooltip={t("admin.v2.delete_employee_action")}
            >
              <AdminDelete size={ICON.sm} aria-hidden="true" />
            </Button>
            ) : null}
          </div>
        ) : null}
      </footer>
    </article>
  );
}
