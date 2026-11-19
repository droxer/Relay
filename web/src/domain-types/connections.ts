export interface ServiceConnection {
  id: string;
  provider: string;
  identity: string;
  label: string;
  tenantLabel?: string;
  status: "connected" | "reconnect_required" | "disconnected";
  actions: string[];
}
export interface ConnectionProvider { id: string; name: string; configured: boolean; actions: string[] }
export interface ConnectionGrant { id?: string; revision?: number; connectionId: string; resources: string[]; actions: string[] }
export type ConnectionTarget = "thread" | "task" | "automation";

export function mailProviderName(provider: string): string | undefined {
  if (provider === "gmail") return "Gmail";
  if (provider === "outlook") return "Outlook";
}

const AUTHORIZATION_RESULTS = ["connected", "cancelled", "failed", "organization_policy", "mailbox_unavailable",
  "identity_mismatch", "offline_access_required", "permissions_required"] as const;

export function readConnectionResult(params: URLSearchParams) {
  const result = AUTHORIZATION_RESULTS.find(value => value === params.get("connectionResult"));
  if (!result) return null;
  const id = params.get("connectionResultId");
  const validId = id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
  return { result, id: result === "connected" && validId ? id : null };
}
