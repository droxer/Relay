"use client";

import { NavProjects } from "./icons";

/** The project glyph, as the page header, empty states, and rails draw it. */
export function ProjectMark({ size = 18 }: { size?: number }) {
  return (
    <span className="project-mark" aria-hidden="true">
      <NavProjects size={size} />
    </span>
  );
}
