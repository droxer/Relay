import { existsSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { relayApiUrl } from 'relay-core/api-url';
import { installRelayMcp, privateWrite } from './relay-mcp-install.js';

export class McpSetupError extends Error {
  constructor(readonly code: string, readonly blocked = false) { super(code); }
}
/** Computer credentials are used only by standalone local CLI sessions. */
export async function bootstrapRelayMcp(options: {
  home: string; stateDir: string; sandboxId: string; backendUrl: string; nodeToken: string;
  runtimes: readonly string[]; fetchFn: typeof fetch; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  if (!options.runtimes.length) return [];
  const tokenFile = join(options.stateDir, 'credentials', 'mcp.token');
  const existingToken = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined;
  const response = await options.fetchFn(relayApiUrl(options.backendUrl, `/daemon-nodes/${encodeURIComponent(options.sandboxId)}/mcp-token`), {
    method: 'POST', headers: { Authorization: `Bearer ${options.nodeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(existingToken === undefined ? {} : { existingToken }),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: 'error',
  });
  if (!response.ok) {
    if ([401,403,410].includes(response.status)) throw new McpSetupError('mcp_token_revoked_or_invalid: reconnect Relay MCP after checking revocation and Computer enrollment', true);
    throw new McpSetupError('mcp_setup_unavailable');
  }
  const grant = await response.json() as { token?: string; renewed?: boolean };
  if (grant.token) {
    if (!/^relay_mcp_[A-Za-z0-9_-]+$/.test(grant.token)) throw new McpSetupError('invalid_mcp_credential');
    privateWrite(tokenFile, grant.token + '\n');
  } else if (!existingToken || grant.renewed !== false) throw new McpSetupError('invalid_mcp_credential_response');
  chmodSync(tokenFile, 0o600);
  return configureRelayMcp(options);
}
/** Establish safe context forwarding before launching a managed native process.
 * Independent of the standalone credential's health: a revoked user grant must
 * neither be revived nor substitute for a separately authorized run grant. */
export function configureRelayMcp(options: {
  home:string; stateDir:string; sandboxId:string; backendUrl:string; runtimes:readonly string[]; env?:NodeJS.ProcessEnv;
}): string[] {
  const tokenFile = join(options.stateDir,'credentials','mcp.token');
  const configFile = join(options.stateDir, 'credentials', 'mcp.json');
  privateWrite(configFile, JSON.stringify({ backendUrl: options.backendUrl, tokenFile }));
  chmodSync(configFile, 0o600);
  const suffix = createHash('sha256').update(`${options.backendUrl}:${options.sandboxId}`).digest('hex').slice(0, 8);
  const installed: string[] = []; const conflicts: string[] = [];
  for (const runtime of options.runtimes) {
    try { installed.push(...installRelayMcp({ home: options.home, runtimes: [runtime], configFile, serverName: `relay-projects-${suffix}`, env: options.env ?? process.env })); }
    catch { conflicts.push(runtime); }
  }
  if (conflicts.length) throw new McpSetupError(`mcp_configuration_conflict (${conflicts.join(', ')}): check runtime configuration and Relay MCP installation lock`, true);
  return installed;
}
export interface McpSetupStatus { status: 'ready'|'retrying'|'blocked'; runtimes: string[]; code?: string; checkedAt: number }
/** Reconcile beside command polling. Retry failures and notice runtime changes. */
export function createMcpReconciler(install: (runtimes: readonly string[])=>Promise<string[]>, now: ()=>number = Date.now) {
  let nextAt = 0; let key = ''; let failures = 0; let pending: Promise<McpSetupStatus>|undefined;
  let state: McpSetupStatus = {status:'retrying',runtimes:[],checkedAt:0};
  return async (runtimes: readonly string[]): Promise<McpSetupStatus> => {
    const nextKey = [...runtimes].sort().join(',');
    if (pending) return pending;
    if (nextKey === key && now() < nextAt) return state;
    key = nextKey;
    pending = (async()=>{
      try {
        const installed = await install(runtimes);
        failures = 0; nextAt = now() + 15*60_000;
        state = {status:'ready',runtimes:installed,checkedAt:now()};
      } catch (error) {
        failures++; nextAt = now() + Math.min(15*60_000,30_000*2**Math.min(failures-1,5));
        state = {status:error instanceof McpSetupError && error.blocked ? 'blocked':'retrying',runtimes:[],
          code:error instanceof McpSetupError ? error.code:'mcp_setup_unavailable',checkedAt:now()};
      }
      return state;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
