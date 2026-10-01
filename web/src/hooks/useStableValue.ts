import { useState } from "react";

/**
 * Keeps a derived value's identity stable while its content key is unchanged.
 *
 * `useMemo` can only key on the inputs it is handed, which is useless when
 * those inputs are freshly-parsed poll responses: the objects differ every
 * few seconds even though nothing the UI reads has changed. Deriving a
 * content signature and holding the last value against it gives consumers a
 * reference that only changes when the content does — so memoized children and
 * effects downstream stop firing on every poll.
 */
export function useStableValue<T>(value: T, signature: string): T {
  const [held, setHeld] = useState(() => ({ signature, value }));
  if (held.signature !== signature) {
    setHeld({ signature, value });
    return value;
  }
  return held.value;
}
