"use client";

import { useTranslation } from "react-i18next";
import type { AdminPageView } from "../../lib/store";
import { hrefForAdminSection } from "../../lib/appRoute";
import { SectionNav, type SectionNavItem } from "../SectionNav";
import {
  AdminDashboard,
  AdminInvite,
  AdminUsers,
  AdminNode,
  AdminOrganization,
} from "../icons";

export type AdminView = AdminPageView;

interface AdminViewToggleProps {
  view: AdminView;
  waitlistOpen?: boolean;
  onChange: (next: AdminView) => void;
}

// The control panel's sections are a second-column rail, not header tabs:
// Dashboard, Users, Waitlist/Invites, Computers, and Organization are
// top-level destinations under one route, each with its own address. The
// rail grammar itself is shared with personal settings — see SectionNav.
export function AdminViewToggle({ view, waitlistOpen = false, onChange }: AdminViewToggleProps) {
  const { t } = useTranslation();
  const items: SectionNavItem<AdminView>[] = [
    { id: "dashboard", label: t("admin.v2.nav_dashboard"), Icon: AdminDashboard, href: hrefForAdminSection("dashboard") },
    { id: "users", label: t("admin.v2.nav_users"), Icon: AdminUsers, href: hrefForAdminSection("users") },
    { id: "waitlist", label: t(waitlistOpen ? "admin.v2.nav_waitlist" : "admin.v2.nav_invitations"), Icon: AdminInvite, href: hrefForAdminSection("waitlist") },
    { id: "computers", label: t("admin.v2.nav_computers"), Icon: AdminNode, href: hrefForAdminSection("computers") },
    { id: "organization", label: t("admin.v2.nav_organization"), Icon: AdminOrganization, href: hrefForAdminSection("organization") },
  ];

  return (
    <SectionNav items={items} value={view} onChange={onChange} label={t("admin.v2.nav_label")} />
  );
}
