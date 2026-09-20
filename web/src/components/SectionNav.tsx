"use client";

import type { ComponentType, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ICON, type GlyphProps } from "./icons";

export type SectionNavItem<Id extends string> = {
  id: Id;
  label: string;
  /** The leading glyph. Omit it when the section leads with a `mark` instead. */
  Icon?: ComponentType<GlyphProps>;
  /**
   * A state mark in the glyph's place — for a rail whose sections are states
   * rather than destinations of their own (the routine board's schedule
   * health). One or the other, never both.
   */
  mark?: ReactNode;
  /** How many records the section holds. Rendered even at zero. */
  count?: number;
  /**
   * The section's own address, when it has one. A section that IS a
   * destination (the control panel's and personal settings' sections, which
   * are `/admin/<section>` and `/settings/<section>`) renders as a link, so it
   * opens in a new tab and copies like the app rail's rows one hairline to the
   * left. A section that is one value of a filter within a route — the routine
   * board's schedule health, which writes `filters.state` — has no address of
   * its own to link to, so it stays a button like the rest of that filter bar.
   */
  href?: string;
};

/**
 * The section list of a rail-and-content surface (the control panel, personal
 * settings, the routine board). Vertical nav grammar rather than tabs: a
 * section is somewhere you go, not a view of one page, so the active one
 * carries `aria-current="page"` — and where it has an address of its own, the
 * row is a link (see `href`).
 */
export function SectionNav<Id extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly SectionNavItem<Id>[];
  value: Id;
  onChange: (next: Id) => void;
  label: string;
}) {
  /* The Button primitive types its handler against a <button>, and `render`
     does not re-type it — the fields read here (the modifier keys and the
     mouse button) are on the base MouseEvent either way. */
  function handleClick(event: { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }, id: Id) {
    // Let the browser have the gestures that mean "somewhere else": on a
    // section that is a link, a modified or middle click opens it in its own
    // tab. Harmless on a section that is a button — nothing else handles them.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onChange(id);
  }

  return (
    <nav className="sec-nav" aria-label={label}>
      <ul className="sec-nav-list">
        {items.map((item) => {
          const active = value === item.id;
          const Icon = item.Icon;
          return (
            <li key={item.id} className="sec-nav-item">
              <Button
                variant="ghost"
                {...(item.href
                  ? // `nativeButton` must travel with the anchor: the primitive
                    // otherwise keeps native button semantics it no longer has.
                    { render: <a href={item.href} />, nativeButton: false as const }
                  : { type: "button" as const })}
                role={item.href ? "link" : undefined}
                className="sec-nav-btn"
                data-active={active ? "true" : "false"}
                data-empty={item.count === 0 ? "true" : undefined}
                aria-current={active ? "page" : undefined}
                onClick={(event) => handleClick(event, item.id)}
              >
                {Icon ? <Icon size={ICON.sm} aria-hidden="true" /> : item.mark}
                <span className="sec-nav-label">{item.label}</span>
                {item.count === undefined ? null : (
                  <span className="sec-nav-count">{item.count}</span>
                )}
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
