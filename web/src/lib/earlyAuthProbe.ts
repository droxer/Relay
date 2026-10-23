/**
 * The `/auth/me` probe the root layout's bootstrap script starts while the
 * HTML is still parsing, for a visitor who was signed in last time. The
 * session probe otherwise waits for the entry chunk to download, parse, and
 * hydrate, and every signed-in request waits on the probe — so starting it
 * from the HTML takes the bundle out of the critical path.
 *
 * The script and `getMe` share this module so the global's name, the URL, and
 * the request shape (a plain credentialed GET, exactly what `apiJson` sends)
 * cannot drift apart.
 */

const PROBE_GLOBAL = "__relayEarlyAuthProbe";

/** A probe older than this is not trusted to describe the session: the first
    `getMe` of a page load arrives long before it, so a later caller (a sign-in
    refreshing capabilities) asks the server itself. */
export const EARLY_AUTH_PROBE_MAX_AGE_MS = 15_000;

interface EarlyAuthProbe {
  readonly startedAt: number;
  readonly response: Promise<Response>;
}

type ProbeWindow = Window & { [PROBE_GLOBAL]?: EarlyAuthProbe };

/** Bootstrap-script statement that starts the probe when the signed-in hint
    is set. Inlined into the HTML, so it is ES5 and swallows its own rejection
    (the app's retrying probe reports a dead backend, not this one). */
export function earlyAuthProbeScript(url: string, signedInHintKey: string): string {
  return `if(localStorage.getItem(${JSON.stringify(signedInHintKey)})==="1"&&window.fetch){`
    + `var a=fetch(${JSON.stringify(url)},{credentials:"include"});a["catch"](function(){});`
    + `window[${JSON.stringify(PROBE_GLOBAL)}]={startedAt:Date.now(),response:a};}`;
}

/** Hands the early probe's response to its one consumer, or nothing when no
    probe ran or it is too old. A response body reads once, so taking it
    clears it. */
export function takeEarlyAuthProbe(now: number = Date.now()): Promise<Response> | undefined {
  if (typeof window === "undefined") return undefined;
  const target = window as ProbeWindow;
  const probe = target[PROBE_GLOBAL];
  if (!probe) return undefined;
  target[PROBE_GLOBAL] = undefined;
  return now - probe.startedAt <= EARLY_AUTH_PROBE_MAX_AGE_MS ? probe.response : undefined;
}
