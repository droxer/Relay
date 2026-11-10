/** A managed process can use only its run-scoped daemon proxy, never a user grant. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relayApiUrl } from 'relay-core/api-url';
import { boundedJsonResponse, negotiatedVersion } from './relay-mcp-http.js';
import { nativeMcpForwarder, type NativeMcpAddress } from './relay-mcp-native.js';
const exec = promisify(execFile);
export const MANAGED_MCP_CONTEXT_ENV = 'RELAY_MCP_RUN_CONTEXT';
export function managedMcpForwarder(backendUrl: string, raw: string) {
    const context = JSON.parse(raw) as {
        disabled?: boolean;
        backendUrl?: string;
        projectId?: string;
        bridgePath?: string;
        native?: NativeMcpAddress;
    };
    const native = context.native && typeof context.native.socketPath === 'string' && typeof context.native.secret === 'string'
        ? nativeMcpForwarder(context.native) : undefined;
    const valid = !context.disabled && context.backendUrl === backendUrl && (native !== undefined || typeof context.bridgePath === 'string');
    let protocolVersion: string | undefined;
    return async (message: unknown): Promise<unknown | undefined> => {
        if (!valid)
            throw new Error('Relay MCP is disabled for this run or backend scope.');
        const reply: unknown = native ? await native('mcp', { message, protocolVersion })
            : JSON.parse((await exec(process.execPath, [context.bridgePath!, 'mcp', JSON.stringify({ message, protocolVersion })], { timeout: 65000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout);
        const version = negotiatedVersion(message, reply);
        if (version)
            protocolVersion = version;
        return reply === null ? undefined : reply;
    };
}
/** Token remains in daemon memory. The workspace contains transport only. */
export function createRunMcpProxy(options: {
    backendUrl: string;
    sandboxId: string;
    nodeToken: string;
    commandId: string;
    leaseId?: string;
    projectId?: string;
    fetchFn: typeof fetch;
    signal: AbortSignal;
}) {
    type Credential = { token: string; expiresAt: number };
    let credential: Credential | undefined;
    let issuing: Promise<Credential> | undefined;
    const request = async (path: string, token: string, body?: unknown, protocolVersion?: string): Promise<Record<string, unknown> | null> => {
        const response = await options.fetchFn(relayApiUrl(options.backendUrl, path), {
            method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(60000)]),
        });
        // Invalidate only the credential used by this request: an older
        // in-flight response must not erase a newly refreshed token. Never
        // replay the request, since a tool write can have an uncertain outcome.
        if (response.status === 401 && credential?.token === token)
            credential = undefined;
        if (response.status === 202 || response.status === 204)
            return null;
        const reply = await boundedJsonResponse(response) as Record<string, unknown>;
        if (!response.ok && !(reply?.jsonrpc === '2.0' && reply.error))
            throw new Error(`Run-scoped Relay MCP request refused (${response.status}).`);
        return reply;
    };
    const currentCredential = async (): Promise<Credential> => {
        // Leave a request deadline's worth of room before server expiry.
        if (credential && credential.expiresAt > Date.now() + 60000) return credential;
        return issuing ??= request(`/daemon-nodes/${encodeURIComponent(options.sandboxId)}/mcp-token`, options.nodeToken,
            { commandId: options.commandId, leaseId: options.leaseId }).then(grant => {
            if (!grant || typeof grant.token !== 'string' || !/^relay_mcp_[A-Za-z0-9_-]+$/.test(grant.token))
                throw new Error('Invalid run credential.');
            // Older backends may omit expiry; a refusal still clears that cache.
            const expiresAt = grant.expiresAt === undefined ? Infinity
                : typeof grant.expiresAt === 'string' ? Date.parse(grant.expiresAt) : NaN;
            if (Number.isNaN(expiresAt) || expiresAt <= Date.now())
                throw new Error('Invalid or expired run credential.');
            return credential = { token: grant.token, expiresAt };
        }).finally(() => { issuing = undefined; });
    };
    return async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
        if (args.projectId !== undefined && args.projectId !== options.projectId)
            throw new Error('Project scope mismatch.');
        const { token } = await currentCredential();
        if (tool === 'mcp')
            return await request('/mcp', token, args.message, typeof args.protocolVersion === 'string' ? args.protocolVersion : undefined);
        // The fallback helper forwards backend-owned tool names just like a
        // native MCP client. It has no catalog and never widens the run grant.
        if (tool.startsWith('relay_')) {
            const reply = await request('/mcp', token, {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:args}});
            const result = reply?.result as {isError?:boolean; structuredContent?:Record<string,unknown>} | undefined;
            if (!result || result.isError) throw new Error('Relay MCP tool refused. Check resource scope and arguments.');
            return result.structuredContent ?? null;
        }
        if (!options.projectId && tool !== 'projects') throw new Error('Project scope required for legacy Project tools.');
        return await request(tool === 'projects' ? '/mcp/projects' : `/mcp/projects/${encodeURIComponent(options.projectId!)}/tools`, token, tool === 'projects' ? undefined : { tool, arguments: { ...args, projectId: options.projectId } });
    };
}
