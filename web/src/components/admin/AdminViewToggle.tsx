"use client";

import { useTranslation } from "react-i18next";
import type { AdminPageView } from "../../lib/store";
import { hrefForAdminSection } from "../../lib/appRoute";
import { SectionNav, type SectionNavItem } from "../SectionNav";
import {
  AdminDashboard,
  AdminUsers,
  AdminNode,
  AdminSettings,
  AdminInbox,
} from "../icons";

export type AdminView = AdminPageView;

interface AdminViewToggleProps {
  view: AdminView;
  onChange: (next: AdminView) => void;
  /** Whether people can ask to join. The section is there either way —
      admins invite by email on every install — and is named for what it
      holds: a waitlist when people can ask, invitations when they cannot. */
  waitlistOpen?: boolean;
}

// The control panel's sections are a second-column rail, not header tabs:
// Users, Computers, and Organization are separate destinations under one
// route, each with its own address. The rail grammar itself is shared with
// personal settings — see SectionNav.
export function AdminViewToggle({ view, onChange, waitlistOpen = false }: AdminViewToggleProps) {
  const { t } = useTranslation();
  const items: SectionNavItem<AdminView>[] = [
    { id: "dashboard", label: t("admin.v2.nav_dashboard"), Icon: AdminDashboard, href: hrefForAdminSection("dashboard") },
    { id: "users", label: t("admin.v2.nav_users"), Icon: AdminUsers, href: hrefForAdminSection("users") },
    { id: "computers", label: t("admin.v2.nav_computers"), Icon: AdminNode, href: hrefForAdminSection("computers") },
    {
      id: "waitlist",
      label: waitlistOpen ? t("admin.v2.nav_waitlist") : t("admin.v2.nav_invitations"),
      Icon: AdminInbox,
      href: hrefForAdminSection("waitlist"),
    },
    { id: "organization", label: t("admin.v2.nav_organization"), Icon: AdminSettings, href: hrefForAdminSection("organization") },
  ];

  return (
    <SectionNav items={items} value={view} onChange={onChange} label={t("admin.v2.nav_label")} />
  );
}
