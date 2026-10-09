"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { ICON, NavBack } from "./icons";

/** The phone layout tier — the one app-wide mobile breakpoint (palette.css). */
export const PHONE_QUERY = "(max-width: 820px)";

/**
 * The phone top bar's two slots, owned and provided by AppShell (`null` until
 * they mount, and off the shell entirely):
 *
 * - `actions`, at the trailing edge, where a list's refresh and create are
 *   portaled instead of keeping a band of their own under the bar;
 * - `lead`, before the title, where a nested screen's back control goes —
 *   so an open agent reads "← Agents" in the bar instead of the bar saying
 *   "Agents" and the page repeating "← Agents" just under it.
 */
export interface MobileTopbarSlots {
  actions: HTMLElement | null;
  lead: HTMLElement | null;
}

export const MobileTopbarSlotContext = createContext<MobileTopbarSlots>({ actions: null, lead: null });

/**
 * Renders `children` in place on wider screens and in the top bar on a phone.
 *
 * `active` is the page saying this surface is the one on screen. A phone shows
 * one pane at a time, but a list and its detail can both be mounted — the
 * agent roster stays mounted under an open agent — and two pages portaling
 * into one slot would put the roster's "+" on the agent's page. A page that
 * is mounted but not on screen passes `active={false}` and contributes
 * nothing to the bar.
 */
export function MobileTopbarActions({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const slot = useContext(MobileTopbarSlotContext).actions;
  const phone = useMediaQuery(PHONE_QUERY);
  if (!phone || !slot) return <>{children}</>;
  return active ? createPortal(children, slot) : null;
}

/**
 * A nested screen's way back to its list. On a phone it is the top bar's
 * leading control — an icon button named by `label`, beside the route title
 * that already says where it goes. Elsewhere it renders `fallback`, the
 * page's own in-flow back button (which its CSS shows only on narrow panes).
 */
export function MobileTopbarBack({ label, onBack, fallback }: {
  label: string;
  onBack: () => void;
  fallback: ReactNode;
}) {
  const slot = useContext(MobileTopbarSlotContext).lead;
  const phone = useMediaQuery(PHONE_QUERY);
  if (!phone || !slot) return <>{fallback}</>;
  return createPortal(
    <Button variant="ghost" type="button" className="mobile-topbar-back" aria-label={label} onClick={onBack}>
      <NavBack size={ICON.md} />
    </Button>,
    slot,
  );
}
