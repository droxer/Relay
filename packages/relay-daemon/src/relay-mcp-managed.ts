/** A managed process can use only its run-scoped daemon proxy, never a user grant. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relayApiUrl } from 'relay-core/api-url';
const exec = promisify(execFile);
export const MANAGED_MCP_CONTEXT_ENV = 'RELAY_MCP_RUN_CONTEXT';
export function managedMcpInvoker(backendUrl: string, raw: string) {
  const context = JSON.parse(raw) as { disabled?: boolean; backendUrl?: string; projectId?: string; bridgePath?: string };
  const valid = !context.disabled && context.backendUrl === backendUrl && typeof context.projectId === 'string' && typeof context.bridgePath === 'string';
  return async (tool: string, args: Record<string,unknown>): Promise<unknown> => {
    if (!valid) throw new Error('Relay MCP is disabled for this run or backend scope.');
    if (tool !== 'projects' && args.projectId !== context.projectId) throw new Error('Project scope mismatch.');
    const result = await exec(process.execPath,[context.bridgePath!,tool,JSON.stringify(args)],{timeout:65_000,maxBuffer:1024*1024,windowsHide:true});
    return JSON.parse(result.stdout);
  };
}
/** Token remains in daemon memory. The workspace contains transport only. */
export function createRunMcpProxy(options: {
  backendUrl:string; sandboxId:string; nodeToken:string; commandId:string; leaseId?:string;
  projectId:string; fetchFn:typeof fetch; signal:AbortSignal;
}) {
  let credential: Promise<string>|undefined;
  const request = async(path:string, token:string, body?:unknown) => {
    const response = await options.fetchFn(relayApiUrl(options.backendUrl,path),{
      method:body === undefined?'GET':'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      ...(body === undefined?{}:{body:JSON.stringify(body)}),redirect:'error',
      signal:AbortSignal.any([options.signal,AbortSignal.timeout(60_000)]),
    });
    if (!response.ok) throw new Error(`Run-scoped Relay MCP request refused (${response.status}).`);
    return await response.json() as Record<string,unknown>;
  };
  return async (tool:string,args:Record<string,unknown>):Promise<Record<string,unknown>> => {
    if (args.projectId !== undefined && args.projectId !== options.projectId) throw new Error('Project scope mismatch.');
    credential ??= request(`/daemon-nodes/${encodeURIComponent(options.sandboxId)}/mcp-token`,options.nodeToken,
      {commandId:options.commandId,leaseId:options.leaseId}).then(grant=>{
        if (typeof grant.token !== 'string' || !/^relay_mcp_[A-Za-z0-9_-]+$/.test(grant.token)) throw new Error('Invalid run credential.');
        return grant.token;
      }).catch(error=>{credential=undefined;throw error;});
    const token=await credential;
    return await request(tool === 'projects'?'/mcp/projects':`/mcp/projects/${encodeURIComponent(options.projectId)}/tools`,token,
      tool === 'projects'?undefined:{tool,arguments:{...args,projectId:options.projectId}});
  };
}
