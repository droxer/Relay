"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmployeeAvatar } from "../../EmployeeAvatar";
import type { ControlPanelDaemonNodeRecord, EmployeeRecord } from "../../../types";
import { AVATAR } from "../../icons";

interface TopEmployeesProps {
  employees: EmployeeRecord[];
  nodes: ControlPanelDaemonNodeRecord[];
  ranked: Array<{ employeeId: string; sessionCount: number }>;
  error?: string | null;
  className?: string;
}

export function TopEmployees({ employees, nodes, ranked, error, className }: TopEmployeesProps) {
  const { t } = useTranslation();

  const rows = useMemo(() => {
    const nodeCountByEmployee = new Map<string, number>();
    for (const node of nodes) {
      if (!node.employeeId) continue;
      nodeCountByEmployee.set(node.employeeId, (nodeCountByEmployee.get(node.employeeId) ?? 0) + 1);
    }
    const employeeMap = new Map(employees.map((e) => [e.id, e] as const));
    const maxCount = ranked[0]?.sessionCount ?? 0;
    return ranked.map((row) => {
      const employee = employeeMap.get(row.employeeId);
      return {
        id: row.employeeId,
        displayName: employee?.displayName ?? row.employeeId,
        sessionCount: row.sessionCount,
        nodeCount: nodeCountByEmployee.get(row.employeeId) ?? 0,
        share: maxCount > 0 ? row.sessionCount / maxCount : 0,
      };
    });
  }, [ranked, employees, nodes]);

  return (
    <Card render={<section />} className={className}>
      <CardHeader>
        <CardTitle render={<h2 />}>{t("admin.v2.dash_top_title")}</CardTitle>
      </CardHeader>
      {error ? (
        <CardDescription>{error}</CardDescription>
      ) : rows.length === 0 ? (
        <CardDescription>{t("admin.v2.dash_top_empty")}</CardDescription>
      ) : (
        <ol className="adm-dash-top-list">
          {rows.map((row, index) => (
            <li key={row.id} className="adm-dash-top-row">
              <span className="adm-dash-top-rank tnum">{index + 1}</span>
              <EmployeeAvatar employeeId={row.id} running={false} size={AVATAR.md} />
              <div className="adm-dash-top-meta">
                <span className="adm-dash-top-name">{row.displayName}</span>
                <span className="adm-dash-top-sub tnum">
                  {t("admin.v2.dash_top_nodes", { count: row.nodeCount })}
                </span>
              </div>
              <span className="adm-dash-top-count tnum">{row.sessionCount}</span>
              {/* Own grid line spanning name → count, so it reads as a row
                  meter rather than an underline of the employee name. */}
              <div className="adm-dash-top-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(row.share * 100, 4)}%` }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
