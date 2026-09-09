"use client";

import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { registerNavigationGuard } from "../lib/navigationGuard";
import { useDialogs } from "@/components/ui/DialogProvider";

export function useUnsavedChangesGuard(enabled: boolean): () => Promise<boolean> {
  const { t } = useTranslation();
  const { confirm } = useDialogs();

  const approved = useRef(false);

  useEffect(() => { approved.current = false; }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [enabled]);

  const confirmDiscard = useCallback(async () => {
    if (!enabled || approved.current) return true;
    const ok = await confirm({
      title: t("unsaved.title"),
      message: t("unsaved.message"),
      confirmLabel: t("unsaved.confirm"),
      cancelLabel: t("dialog.cancel"),
      tone: "danger",
    });
    if (ok) approved.current = true;
    return ok;
  }, [confirm, enabled, t]);

  useEffect(() => {
    if (enabled) return registerNavigationGuard(confirmDiscard);
  }, [enabled, confirmDiscard]);

  return confirmDiscard;
}
