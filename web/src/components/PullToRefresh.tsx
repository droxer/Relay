import { useEffect, useEffectEvent, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { PHONE_QUERY } from "./MobileTopbarSlot";
import { ActionScrollBottom, ICON, NavRefresh } from "./icons";
import { useDialogs } from "./ui/DialogProvider";

const RELEASE_DISTANCE = 72;

export function PullToRefresh({ target, onRefresh }: {
  target: RefObject<HTMLDivElement | null>;
  onRefresh: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const phone = useMediaQuery(`${PHONE_QUERY} and (pointer: coarse)`);
  const [pull, setPull] = useState<number | "refreshing">(0);
  const refresh = useEffectEvent(() => onRefresh());
  const reportError = useEffectEvent(() => announce({ message: t("nav.refresh_failed"), tone: "error" }));

  useEffect(() => {
    const list = target.current;
    if (!phone || !list) return;
    let start: { x: number; y: number } | null = null;
    let distance = 0;
    let refreshing = false;
    let disposed = false;

    function cancel() {
      start = null;
      distance = 0;
      if (!refreshing) setPull(0);
    }

    function onStart(event: TouchEvent) {
      cancel();
      if (refreshing || event.touches.length !== 1 || !(event.target instanceof Element)) return;
      if (event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      // The Task table can scroll inside its list, while the Thread list
      // scrolls directly. A pull starts only when both are at the top.
      for (let element: Element | null = event.target; element; element = element.parentElement) {
        if (element.scrollTop > 0) return;
      }
      const touch = event.touches[0];
      if (touch) start = { x: touch.clientX, y: touch.clientY };
    }

    function onMove(event: TouchEvent) {
      if (!start) return;
      const touch = event.touches[0];
      if (!event.cancelable || event.touches.length !== 1 || !touch) return cancel();
      const dx = Math.abs(touch.clientX - start.x);
      const dy = touch.clientY - start.y;
      if (distance === 0 && dy <= dx) {
        if (Math.max(dx, -dy) >= 6) cancel();
        return;
      }
      // Keep ordinary scrolling native. Cancel the default only once the
      // finger has claimed a downward pull from the top of the list.
      event.preventDefault();
      distance = Math.max(0, dy);
      setPull(distance);
    }

    async function onEnd() {
      const armed = distance >= RELEASE_DISTANCE;
      cancel();
      if (!armed) return;
      refreshing = true;
      setPull("refreshing");
      try {
        await refresh();
      } catch {
        if (!disposed) reportError();
      } finally {
        refreshing = false;
        if (!disposed) setPull(0);
      }
    }

    list.addEventListener("touchstart", onStart, { passive: true });
    list.addEventListener("touchmove", onMove, { passive: false });
    list.addEventListener("touchend", onEnd);
    list.addEventListener("touchcancel", cancel);
    return () => {
      disposed = true;
      list.removeEventListener("touchstart", onStart);
      list.removeEventListener("touchmove", onMove);
      list.removeEventListener("touchend", onEnd);
      list.removeEventListener("touchcancel", cancel);
      setPull(0);
    };
  }, [phone, target]);

  if (!phone) return null;
  const refreshing = pull === "refreshing";
  const progress = refreshing ? 1 : Math.min(pull / RELEASE_DISTANCE, 1);
  return (
    <div
      className="pull-to-refresh"
      hidden={pull === 0}
      data-armed={progress === 1}
      style={{ translate: `-50% ${progress * 16}px` }}
      role={refreshing ? "status" : undefined}
      aria-label={refreshing ? t("nav.refreshing") : undefined}
    >
      {refreshing
        ? <NavRefresh size={ICON.md} className="spin" aria-hidden="true" />
        : <ActionScrollBottom size={ICON.md} aria-hidden="true" />}
    </div>
  );
}
