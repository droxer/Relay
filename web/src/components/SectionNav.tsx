"use client";

import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { ICON, type GlyphProps } from "./icons";

export type SectionNavItem<Id extends string> = {
  id: Id;
  label: string;
  Icon: ComponentType<GlyphProps>;
};

/**
 * The section list of a rail-and-content surface (the control panel, personal
 * settings). Vertical nav grammar rather than tabs: these are destinations
 * under one route, not views of one page, so the active one carries
 * `aria-current="page"`.
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
                aria-current={active ? "page" : undefined}
                onClick={() => onChange(item.id)}
              >
                <Icon size={ICON.sm} aria-hidden="true" />
                <span className="sec-nav-label">{item.label}</span>
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
