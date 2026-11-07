/** Local stdio/HTTP transport only. Python owns the MCP protocol and tools. */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forwardMcp, type Forward } from './relay-mcp-http.js';
export { forwardMcp } from './relay-mcp-http.js';
import { managedMcpForwarder, MANAGED_MCP_CONTEXT_ENV } from './relay-mcp-managed.js';
import { serveMcpStdio } from 'relay-core/mcp-stdio';
export async function serveMcp(forward: Forward): Promise<void> {
    await serveMcpStdio(forward, 'Relay MCP unavailable. Check scope, credential health, and backend availability.');
}
export async function runMcp(args: string[]): Promise<void> {
    const path = args[0] === '--config' ? args[1] : undefined;
    if (!path)
        throw new Error('Usage: relay mcp --config <private-config.json>');
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
        backendUrl: string;
        tokenFile: string;
    };
    const managed = process.env[MANAGED_MCP_CONTEXT_ENV]?.trim() || undefined;
    await serveMcp(managed !== undefined ? managedMcpForwarder(config.backendUrl, managed) : forwardMcp(config.backendUrl, config.tokenFile));
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runMcp(process.argv.slice(2)).catch(() => { process.stderr.write('Relay MCP could not start. Check its private configuration.\n'); process.exitCode = 1; });
}
