"use client";

import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmployeeAvatar } from "../../EmployeeAvatar";
import type { EmployeeRecord } from "../../../types";
import { AVATAR } from "../../icons";
import { employeeHandleOf } from "../../../lib/employeeHandle";

interface TopEmployeesProps {
  employees: EmployeeRecord[];
  ranked: Array<{ employeeId: string; sessionCount: number }>;
  error?: string | null;
  className?: string;
}

export function TopEmployees({ employees, ranked, error, className }: TopEmployeesProps) {
  const { t } = useTranslation();
  const titleId = useId();

  const rows = useMemo(() => {
    const employeeMap = new Map(employees.map((e) => [e.id, e] as const));
    return ranked.map((row) => {
      const employee = employeeMap.get(row.employeeId);
      return {
        id: row.employeeId,
        // A ranked employee can have left the roster; the handle helper keeps
        // their UUID off the screen either way.
        displayName: employee?.displayName || employeeHandleOf(employee ?? { id: row.employeeId }),
        sessionCount: row.sessionCount,
      };
    });
  }, [ranked, employees]);

  return (
    <Card render={<section />} className={className}>
      <CardHeader>
        <CardTitle render={<h2 id={titleId} />}>{t("admin.v2.dash_top_title")}</CardTitle>
      </CardHeader>
      {error ? (
        <CardDescription>{error}</CardDescription>
      ) : rows.length === 0 ? (
        <CardDescription>{t("admin.v2.dash_top_empty")}</CardDescription>
      ) : (
        // The panel caps its height, so the list scrolls; a scroller with no
        // focusable content is unreachable by keyboard without a tab stop.
        <ol className="adm-dash-top-list" tabIndex={0} aria-labelledby={titleId}>
          {rows.map((row, index) => (
            <li key={row.id} className="adm-dash-top-row">
              <span className="adm-dash-top-rank tnum">{index + 1}</span>
              <EmployeeAvatar displayName={row.displayName} running={false} size={AVATAR.md} />
              {/* One line per person: name and count. The computer count and
                  the share meter under each row restated the rank. */}
              <span className="adm-dash-top-name">{row.displayName}</span>
              <span className="adm-dash-top-count tnum">{row.sessionCount}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
