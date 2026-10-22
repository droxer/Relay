import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;

/** Date.now(), refreshed once a minute — the clock relative stamps read
 * ("3 min ago"), so a surface re-renders at most once a minute for time. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
