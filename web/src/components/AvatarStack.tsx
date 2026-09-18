"use client";

import type { ReactNode } from "react";

/**
 * A group of faces read as one group: overlapping marks, a "+N" chip once the
 * group runs past `max`, and the names on hover rather than in the row.
 *
 * This is the one place the stack's geometry lives — the task drawer's team
 * roster and the thread header's participants are the same fact ("who is on
 * this"), so they are the same shape. A caller supplies each face's mark; the
 * stack owns only the frame, the overlap, and the overflow count.
 */
export function AvatarStack({ items, max = 4, label, className }: {
  items: { id: string; name: string; mark: ReactNode }[];
  /** Faces drawn before the rest collapse into "+N". */
  max?: number;
  /** Names the group for assistive tech — the faces themselves are decorative. */
  label: string;
  className?: string;
}) {
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const hidden = items.slice(max);
  return (
    <span className={className ? `avatar-stack ${className}` : "avatar-stack"} aria-label={label}>
      {shown.map((item) => (
        <span key={item.id} className="avatar-stack-face" title={item.name}>
          {item.mark}
        </span>
      ))}
      {hidden.length > 0 ? (
        <span className="avatar-stack-more" title={hidden.map((item) => item.name).join(", ")}>
          +{hidden.length}
        </span>
      ) : null}
    </span>
  );
}
