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
};

/**
 * The section list of a rail-and-content surface (the control panel, personal
 * settings, the routine board). Vertical nav grammar rather than tabs: these
 * are destinations under one route, not views of one page, so the active one
 * carries `aria-current="page"`.
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
                type="button"
                className="sec-nav-btn"
                data-active={active ? "true" : "false"}
                data-empty={item.count === 0 ? "true" : undefined}
                aria-current={active ? "page" : undefined}
                onClick={() => onChange(item.id)}
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
