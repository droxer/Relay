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
  const touchStart = useRef<{ id: number; x: number; y: number } | null>(null);

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
      actionProps: {
        children: t("app_update.reload"),
        onClick: () => window.location.reload(),
        // Complete a touch directly rather than relying on the compatibility
        // click after toast gesture handling in an installed mobile app.
        onTouchStart: (event) => {
          const touch = event.touches[0];
          touchStart.current = event.touches.length === 1
            ? { id: touch.identifier, x: touch.clientX, y: touch.clientY }
            : null;
        },
        onTouchMove: (event) => {
          const start = touchStart.current;
          const touch = event.touches[0];
          if (!start || !touch || touch.identifier !== start.id
            || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) {
            touchStart.current = null;
          }
        },
        onTouchCancel: () => { touchStart.current = null; },
        onTouchEnd: (event) => {
          const start = touchStart.current;
          touchStart.current = null;
          const touch = Array.from(event.changedTouches).find((item) => item.identifier === start?.id);
          if (!start || !touch || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) return;
          // Cancel the synthesized click so a normal tap only reloads once.
          event.preventDefault();
          window.location.reload();
        },
      },
    });
  }, [stale, t]);

  return null;
}
