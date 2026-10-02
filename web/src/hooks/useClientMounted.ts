"use client";

import { useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

/** True once the client owns the tree — use to defer localStorage/hash reads.
 *  False while a prerendered page hydrates (the server snapshot), true for
 *  every render after; a component first mounted on the client is never
 *  hydrating, so it reads true straight away. */
export function useClientMounted(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}
