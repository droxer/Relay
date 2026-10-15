/**
 * Whether the open thread's SSE tail is currently connected.
 *
 * useSessionEvents owns the EventSource and writes here; the sessions list
 * poll reads it to back off while pushed events keep the open thread fresh.
 * A module-level store (not React state) so the writer and reader can live
 * in unrelated hooks without threading a value through App.
 */
let connected = false;
const listeners = new Set<() => void>();

export function isSessionStreamConnected(): boolean {
  return connected;
}

export function setSessionStreamConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const listener of listeners) listener();
}

export function subscribeSessionStream(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
