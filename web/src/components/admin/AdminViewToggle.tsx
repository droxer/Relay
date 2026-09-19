"use client";

import { useTranslation } from "react-i18next";
import type { AdminPageView } from "../../lib/store";
import { hrefForAdminSection } from "../../lib/appRoute";
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
// Employees, Computers, and Organization are separate destinations under one
// route, each with its own address. The rail grammar itself is shared with
// personal settings — see SectionNav.
export function AdminViewToggle({ view, onChange }: AdminViewToggleProps) {
  const { t } = useTranslation();
  const items: SectionNavItem<AdminView>[] = [
    { id: "dashboard", label: t("admin.v2.nav_dashboard"), Icon: AdminDashboard, href: hrefForAdminSection("dashboard") },
    { id: "employees", label: t("admin.v2.nav_employees"), Icon: AdminEmployees, href: hrefForAdminSection("employees") },
    { id: "computers", label: t("admin.v2.nav_computers"), Icon: AdminNode, href: hrefForAdminSection("computers") },
    { id: "organization", label: t("admin.v2.nav_organization"), Icon: AdminSettings, href: hrefForAdminSection("organization") },
  ];

  return (
    <SectionNav items={items} value={view} onChange={onChange} label={t("admin.v2.nav_label")} />
  );
}
