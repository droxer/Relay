/** A per-run stdio MCP proxy. It writes no credentials or configuration files. */
export interface ConnectionToolAccess { url: string; token: string }

// Self-contained so the same launcher runs on native Computers and inside a VM.
// Only the run credential crosses this boundary; provider tokens stay server-side.
const PROXY = `
const {createInterface}=require('node:readline');
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
let chain=Promise.resolve();
input.on('line',line=>{chain=chain.then(async()=>{
 let rpc;try{rpc=JSON.parse(line)}catch{return}
 try{
  const response=await fetch(process.env.RELAY_CONNECTION_URL,{method:'POST',
   headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.RELAY_CONNECTION_TOKEN},
   body:JSON.stringify(rpc),signal:AbortSignal.timeout(30000),redirect:'error'});
  if(rpc.id===undefined||rpc.id===null)return;
  if(!response.ok)throw new Error('Connection tools unavailable ('+response.status+')');
  const reader=response.body.getReader();let size=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
   if(size>2097152){await reader.cancel();throw new Error('Connection response too large')}chunks.push(value)}
  process.stdout.write(Buffer.concat(chunks).toString()+'\\n');
 }catch{if(rpc.id!==undefined&&rpc.id!==null)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:rpc.id,
  error:{code:-32000,message:'Connection tools unavailable; do not retry writes with an uncertain outcome.'}})+'\\n')}
}).catch(()=>{})});
`;

export function connectionServer(access: ConnectionToolAccess) {
  const url = new URL(access.url);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "host.boxlite.internal"].includes(url.hostname)))) {
    throw new Error("Connection tools require a trusted HTTPS backend");
  }
  return { type: "stdio" as const, command: "node", args: ["-e", PROXY],
    env: { RELAY_CONNECTION_URL: access.url, RELAY_CONNECTION_TOKEN: access.token } };
}

export function codexConnectionArgs(access: ConnectionToolAccess | undefined): string[] {
  if (!access) return [];
  const spec = connectionServer(access);
  return Object.entries({ command: spec.command, args: spec.args, "env.RELAY_CONNECTION_URL": spec.env.RELAY_CONNECTION_URL,
    "env.RELAY_CONNECTION_TOKEN": spec.env.RELAY_CONNECTION_TOKEN }).flatMap(([key, value]) =>
    ["-c", `mcp_servers.relay_connections.${key}=${JSON.stringify(value)}`]);
}
