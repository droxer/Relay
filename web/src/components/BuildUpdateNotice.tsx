"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { installBuildFreshnessWatch, isBuildStale, subscribeBuildStale } from "../lib/buildFreshness";

const UPDATE_TOAST_ID = "relay-build-update";

/** Watches for a newer deploy and, once one is out, offers a reload that
    stays until taken or dismissed — never a forced one, since the person may
    be typing. The next move to another page loads it anyway (appRoute.ts). */
export function BuildUpdateNotice() {
  const { t } = useTranslation();
  const stale = useSyncExternalStore(subscribeBuildStale, isBuildStale, () => false);
  const shown = useRef(false);

  useEffect(() => installBuildFreshnessWatch(), []);

  useEffect(() => {
    if (!stale || shown.current) return;
    shown.current = true;
    toast.add({
      id: UPDATE_TOAST_ID,
      title: t("app_update.title"),
      description: t("app_update.body"),
      type: "info",
      timeout: 0,
      priority: "low",
      actionProps: { children: t("app_update.reload"), onClick: () => window.location.reload() },
    });
  }, [stale, t]);

  return null;
}
