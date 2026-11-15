/** Event ingestion may synchronously persist artifact indexes (10–14 seconds).
 * Keep its deadline distinct from short control-plane probes. */
export const EVENT_REQUEST_TIMEOUT_MS = 60_000;
