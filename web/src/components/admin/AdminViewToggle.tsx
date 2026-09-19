"use client";

import { useTranslation } from "react-i18next";
import type { AdminPageView } from "../../lib/store";
import { SectionNav, type SectionNavItem } from "../SectionNav";
import {
  AdminDashboard,
  AdminEmployees,
  AdminNode,
  AdminSettings,
} from "../icons";

export type AdminView = AdminPageView;

interface AdminViewToggleProps {
  view: AdminView;
  onChange: (next: AdminView) => void;
}

// The control panel's sections are a second-column rail, not header tabs:
// Employees, Computers, and Settings are separate destinations under one
// route. The rail grammar itself is shared with personal settings — see
// SectionNav.
export function AdminViewToggle({ view, onChange }: AdminViewToggleProps) {
  const { t } = useTranslation();
  const items: SectionNavItem<AdminView>[] = [
    { id: "dashboard", label: t("admin.v2.nav_dashboard"), Icon: AdminDashboard },
    { id: "employees", label: t("admin.v2.nav_employees"), Icon: AdminEmployees },
    { id: "nodes", label: t("admin.v2.nav_nodes"), Icon: AdminNode },
    { id: "settings", label: t("admin.v2.nav_settings"), Icon: AdminSettings },
  ];

  return (
    <SectionNav items={items} value={view} onChange={onChange} label={t("admin.v2.nav_label")} />
  );
}
