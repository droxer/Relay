"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  ICON,
  ViewGrid,
  ViewList,
} from "../icons";

export type AdminLayout = "card" | "list";

interface AdminLayoutToggleProps {
  layout: AdminLayout;
  onChange: (next: AdminLayout) => void;
}

// Card/list density switch shared by the Users and Nodes views. Reuses the
// backlog toggle geometry so it reads identically to the Backlog/Routine pages.
export function AdminLayoutToggle({ layout, onChange }: AdminLayoutToggleProps) {
  const { t } = useTranslation();
  return (
    <div className="view-toggle adm-layout-toggle" role="group" aria-label={t("admin.v2.layout_label")}>
      <Button
        variant="ghost"
        type="button"
        className="view-toggle-btn"
        data-active={layout === "card" ? "true" : "false"}
        aria-pressed={layout === "card"}
        tooltip={t("admin.v2.view_card")}
        onClick={() => onChange("card")}
      >
        <ViewGrid size={ICON.sm} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        type="button"
        className="view-toggle-btn"
        data-active={layout === "list" ? "true" : "false"}
        aria-pressed={layout === "list"}
        tooltip={t("admin.v2.view_list")}
        onClick={() => onChange("list")}
      >
        <ViewList size={ICON.sm} aria-hidden="true" />
      </Button>
    </div>
  );
}
