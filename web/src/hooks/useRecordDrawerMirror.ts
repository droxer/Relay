"use client";

import { useEffect, useState } from "react";

/**
 * Keeps the record a closing drawer is still showing.
 *
 * A record drawer opens over a board and is addressed by the URL, so closing
 * it clears the address immediately — while the drawer still has an exit
 * animation to play, with nothing left to render. Every board that mounts a
 * record drawer therefore mirrors the open record and releases the mirror
 * from `onClosed`; three of them had written that out by hand, and one had
 * drifted to adjusting the mirror during render instead of in an effect.
 *
 * `key` is the record's identity as a primitive — a routine run is two ids,
 * so the value it mirrors is an object that would otherwise be new on every
 * render. The value is read through the key, never depended on directly.
 */
export function useRecordDrawerMirror<T>(
  key: string | null,
  value: T | null,
): { record: T | null; release: () => void } {
  const [mirror, setMirror] = useState<T | null>(null);

  useEffect(() => {
    if (key === null) return;
    setMirror(value);
    // `key` IS the value's identity: adding `value` would re-run this on
    // every render for the object-shaped callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    record: key === null ? mirror : value,
    release: () => setMirror(null),
  };
}
