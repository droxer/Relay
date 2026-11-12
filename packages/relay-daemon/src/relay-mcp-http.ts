/** Bounded authenticated HTTP transport; no MCP tool catalog or dispatch. */
import { readFileSync } from 'node:fs';
import { relayApiUrl } from 'relay-core/api-url';
import { createBackendFetch } from './backend-fetch.js';
export type Forward = (message: unknown) => Promise<unknown | undefined>;
export function forwardMcp(backendUrl: string, tokenFile: string): Forward {
    const url = new URL(backendUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))
        throw new Error('Relay MCP requires HTTPS or loopback HTTP.');
    let protocolVersion: string | undefined;
    const send = createBackendFetch();
    return async (message) => {
        const token = readFileSync(tokenFile, 'utf8').trim();
        if (!/^relay_mcp_[A-Za-z0-9_-]+$/.test(token))
            throw new Error('Invalid Relay MCP credential.');
        const response = await send(relayApiUrl(backendUrl, '/mcp'), {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream', ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}) },
            body: JSON.stringify(message), signal: AbortSignal.timeout(60000), redirect: 'error',
        });
        if (response.status === 202 || response.status === 204)
            return undefined;
        const reply = await boundedJsonResponse(response);
        if (!reply || typeof reply !== 'object' || Array.isArray(reply) || (reply as Record<string, unknown>).jsonrpc !== '2.0')
            throw new Error('Relay MCP HTTP request failed.');
        const version = negotiatedVersion(message, reply);
        if (version)
            protocolVersion = version;
        return reply;
    };
}
export function negotiatedVersion(message: unknown, reply: unknown): string | undefined {
    if ((message as {
        method?: unknown;
    } | null)?.method !== 'initialize')
        return undefined;
    const version = (reply as {
        result?: {
            protocolVersion?: unknown;
        };
    } | null)?.result?.protocolVersion;
    return typeof version === 'string' && version.length < 40 ? version : undefined;
}
export async function boundedJsonResponse(response: Response): Promise<unknown> {
    if (Number(response.headers.get('content-length') ?? 0) > 1024 * 1024 || !response.body)
        throw new Error('Relay MCP response is unavailable or too large.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done)
                break;
            size += part.value.length;
            if (size > 1024 * 1024)
                throw new Error('Relay MCP response too large.');
            chunks.push(part.value);
        }
    }
    finally {
        await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
