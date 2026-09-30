/* Product features that ship switched off.

   Next.js inlines `NEXT_PUBLIC_*` at build time, so a flag is fixed per build.
   Each one mirrors a backend switch: turning a feature on means setting both,
   or the page would call routes the backend has not mounted. */

/** Chat channels (the Channels page and its admin setup). Off by default;
 *  pairs with `RELAY_CHANNELS_ENABLED` on the backend. */
export const CHANNELS_ENABLED = process.env.NEXT_PUBLIC_RELAY_CHANNELS_ENABLED === "1";
