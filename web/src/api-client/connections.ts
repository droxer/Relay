import { apiJson } from "./client.ts";
import { connectionProvidersGuard, connectionsGuard } from "./responseShape.ts";

import type { ServiceConnection, ConnectionProvider, ConnectionGrant, ConnectionTarget } from "../domain-types/connections.ts";
export type { ServiceConnection, ConnectionProvider, ConnectionGrant, ConnectionTarget } from "../domain-types/connections.ts";
export const listConnections = () => apiJson<{ connections: ServiceConnection[] }>("/connections", { guard: connectionsGuard });
export const listConnectionProviders = () => apiJson<{ providers: ConnectionProvider[] }>("/connection-providers", { guard: connectionProvidersGuard });
export const startConnection = (provider: string, reconnectId?: string) => apiJson<{ url: string }>("/connections/authorizations", {
  method: "POST", body: { provider, reconnectId, returnTo: "/settings/connections" },
});
export const disconnectConnection = (id: string) => apiJson(`/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
export const connectionUsage = (id: string) => apiJson<{ usage: Array<{ targetType: ConnectionTarget; targetId: string }> }>(`/connections/${encodeURIComponent(id)}/usage`);
export const connectionResources = (id: string, cursor = "") => apiJson<{ resources: Array<{ id: string; name: string }>; nextCursor: string | null }>(`/connections/${encodeURIComponent(id)}/resources?cursor=${encodeURIComponent(cursor)}`);
export const getConnectionGrants = (kind: ConnectionTarget, id: string) => apiJson<{
  grants: ConnectionGrant[]; targetType: ConnectionTarget; targetId: string; readOnly: boolean;
}>(`/connection-grants/${kind}/${encodeURIComponent(id)}`);
export const saveConnectionGrants = (kind: ConnectionTarget, id: string, grants: ConnectionGrant[]) =>
  apiJson(`/connection-grants/${kind}/${encodeURIComponent(id)}`, { method: "PUT", body: { grants } });

export function validConnectionGrants(grants: ConnectionGrant[] | undefined): boolean {
  return !grants || grants.every(grant => grant.resources.length > 0 && grant.actions.length > 0);
}
