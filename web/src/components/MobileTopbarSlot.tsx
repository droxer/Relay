"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "../hooks/useMediaQuery";

/** The phone layout tier — the one app-wide mobile breakpoint (palette.css). */
export const PHONE_QUERY = "(max-width: 820px)";

/**
 * The phone top bar's action slot: the element page actions are portaled into
 * so a list's refresh and create sit at the top bar's trailing edge instead of
 * in a band of their own under it. AppShell owns the element and provides it;
 * `null` until it mounts, and off the shell entirely.
 */
export const MobileTopbarSlotContext = createContext<HTMLElement | null>(null);

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
  const slot = useContext(MobileTopbarSlotContext);
  const phone = useMediaQuery(PHONE_QUERY);
  if (!phone || !slot) return <>{children}</>;
  return active ? createPortal(children, slot) : null;
}
