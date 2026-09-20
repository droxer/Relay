import { relayApiUrl } from "relay-core";

export interface ComputerAuthorization {
  sandboxId: string;
  employeeId: string;
  workspacePath: string;
  token: string;
}

/** The browser gets an approval URL; only this process holds the polling secret. */
export async function authorizeComputer(options: {
  backendUrl: string;
  workspace: string;
  displayName: string;
  openBrowser: (url: string) => void;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}): Promise<ComputerAuthorization> {
  const send = options.fetchFn ?? fetch;
  const timeout = AbortSignal.timeout(10 * 60_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const started = await send(relayApiUrl(options.backendUrl, "/computer-authorizations"), {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: requestSignal(),
    body: JSON.stringify({ workspacePath: options.workspace, displayName: options.displayName }),
  });
  if (!started.ok) throw new Error(`Could not request computer authorization (${started.status}).`);
  const grant = await started.json() as { deviceCode?: string; verificationUrl?: string };
  if (!grant.deviceCode || !grant.verificationUrl) throw new Error("Incomplete computer authorization response.");
  const verification = new URL(grant.verificationUrl);
  if (verification.origin !== new URL(options.backendUrl).origin || verification.username || verification.password) {
    throw new Error("Computer approval URL must use the backend origin.");
  }
  options.openBrowser(verification.href);
  while (!signal.aborted) {
    const response = await send(relayApiUrl(options.backendUrl, "/computer-authorizations/token"), {
      method: "POST", headers: { Authorization: `Device ${grant.deviceCode}` }, signal: requestSignal(),
    });
    if (response.status === 200) {
      const result = await response.json() as ComputerAuthorization;
      if (!result.token || !result.sandboxId || !result.employeeId || result.workspacePath !== options.workspace) {
        throw new Error("Incomplete or mismatched computer authorization.");
      }
      return result;
    }
    await response.body?.cancel();
    if (response.status !== 202) throw new Error(`Computer authorization expired or was rejected (${response.status}). Run setup again.`);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, options.pollIntervalMs ?? 2000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
    });
  }
  throw new Error("Computer authorization timed out. Run setup again.");
}
