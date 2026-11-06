import { existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { relayApiUrl } from 'relay-core/api-url';
import { installRelayMcp, privateWrite } from './relay-mcp-install.js';

/** Called only for the real user-local execution environment after enrollment. */
export async function bootstrapRelayMcp(options: {
  home: string; stateDir: string; sandboxId: string; backendUrl: string; nodeToken: string;
  runtimes: readonly string[]; fetchFn: typeof fetch; signal?: AbortSignal; env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  if (!options.runtimes.length) return [];
  const tokenFile = join(options.stateDir, 'credentials', 'mcp.token');
  if (!existsSync(tokenFile)) {
    const response = await options.fetchFn(relayApiUrl(options.backendUrl, `/daemon-nodes/${encodeURIComponent(options.sandboxId)}/mcp-token`), {
      method: 'POST', headers: { Authorization: `Bearer ${options.nodeToken}`, 'Content-Type': 'application/json' },
      body: '{}', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Relay MCP token issuance failed.');
    const grant = await response.json() as { token?: string };
    if (!grant.token || !/^relay_mcp_[A-Za-z0-9_-]+$/.test(grant.token)) throw new Error('Invalid Relay MCP credential response.');
    privateWrite(tokenFile, grant.token + '\n');
  }
  chmodSync(tokenFile, 0o600);
  const configFile = join(options.stateDir, 'credentials', 'mcp.json');
  privateWrite(configFile, JSON.stringify({ backendUrl: options.backendUrl, tokenFile }));
  chmodSync(configFile, 0o600);
  const suffix = createHash('sha256').update(`${options.backendUrl}:${options.sandboxId}`).digest('hex').slice(0, 8);
  return installRelayMcp({ home: options.home, runtimes: options.runtimes, configFile, serverName: `relay-projects-${suffix}`, env: options.env ?? process.env });
}
