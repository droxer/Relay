export interface ServiceConnection {
  id: string;
  provider: string;
  identity: string;
  label: string;
  status: "connected" | "reconnect_required" | "disconnected";
  actions: string[];
}
export interface ConnectionProvider { id: string; name: string; configured: boolean; actions: string[] }
export interface ConnectionGrant { id?: string; revision?: number; connectionId: string; resources: string[]; actions: string[] }
export type ConnectionTarget = "thread" | "task" | "automation";
