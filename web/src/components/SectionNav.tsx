"use client";

import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { ICON, type GlyphProps } from "./icons";

export type SectionNavItem<Id extends string> = {
  id: Id;
  label: string;
  Icon: ComponentType<GlyphProps>;
  /** The section's own address. Every section is a destination with a URL, so
      the row is a link — openable in a new tab and copyable — exactly like the
      app rail's rows one hairline to the left. */
  href: string;
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
  /* The Button primitive types its handler against a <button>, and `render`
     does not re-type it — the fields read here (the modifier keys and the
     mouse button) are on the base MouseEvent either way. */
  function handleClick(event: { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }, id: Id) {
    // Let the browser have the gestures that mean "somewhere else": a modified
    // click or a middle click opens the section in its own tab.
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
                render={<a href={item.href} />}
                className="sec-nav-btn"
                data-active={active ? "true" : "false"}
                aria-current={active ? "page" : undefined}
                onClick={(event) => handleClick(event, item.id)}
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
