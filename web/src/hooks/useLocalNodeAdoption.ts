"use client";

import { useEffect, useRef } from "react";

/**
 * Claims this machine's local daemon nodes for the signed-in admin, once.
 *
 * Adoption reads /api/v1/admin/daemon-nodes, which is admin-only: running it
 * for every signed-in user meant a 403 on each load whose failure was
 * swallowed, so the caller gates it exactly like the query it depends on
 * (useLocalDaemonNodes). A failed attempt is logged and clears the latch, so
 * the next change to `adopt` — it is rebuilt whenever the node list or
 * tokens refresh — tries again instead of never.
 */
export function useLocalNodeAdoption(enabled: boolean, adopt: () => Promise<void>): void {
  const startedRef = useRef(false);
  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    adopt().catch((error: unknown) => {
      startedRef.current = false;
      console.error("[relay] adopting this machine's local computers failed; will retry", error);
    });
  }, [adopt, enabled]);
}
