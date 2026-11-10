/** Transport signals a rejected cookie; the auth owner confirms whether the
 * login expired. Bearer-token failures never pass through this channel. */
const listeners = new Set<() => void>();

export function subscribeSessionRevalidation(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function requestSessionRevalidation(): void {
  for (const listener of listeners) listener();
}
