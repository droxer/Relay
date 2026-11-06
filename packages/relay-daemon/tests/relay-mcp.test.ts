import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { installRelayMcp } from '../src/relay-mcp-install.js';

// Transport fixtures deliberately provide a Python-owned catalog, unrelated to
// the real catalog. Changing backend tools must never require a client release.
const tools=[{name:'python_defined_tool',description:'Provided by the backend',inputSchema:{type:'object',properties:{operations:{type:'array',items:{type:'object',properties:{kind:{enum:['create','update']}}}}}}}];
async function fixtureServer(token:string){
 const server=createServer(async(request,response)=>{
  assert.equal(request.url,'/api/v1/mcp');assert.equal(request.headers.authorization,`Bearer ${token}`);
  let raw='';for await(const chunk of request)raw+=chunk;const message=JSON.parse(raw);
  if(message.id===undefined){response.writeHead(202).end();return;}
  const result=message.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'python-server',version:'1'}}:message.method==='tools/list'?{tools}:{content:[{type:'text',text:'Projects'}],structuredContent:{projects:[{id:'one'}]}};
  response.setHeader('Content-Type','application/json');response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {server,url:`http://127.0.0.1:${(server.address() as any).port}`,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

test('installation preserves settings/comments, is idempotent and refuses user-owned collisions',()=>{
 const home=mkdtempSync(join(tmpdir(),'relay-install-'));
 try{
  mkdirSync(join(home,'.codex'));writeFileSync(join(home,'.codex','config.toml'),'# personal\nmodel = "test"\n');
  writeFileSync(join(home,'.claude.json'),'{\n// personal\n"theme":"dark", "mcpServers":{"other":{"command":"test"}},\n}\n');
  const options={home,runtimes:['codex','claude','opencode','kimi'] as const,configFile:join(home,'private config.json'),serverName:'relay-projects-test'};
  assert.equal(installRelayMcp(options).length,4);
  const before=readFileSync(join(home,'.claude.json'),'utf8');assert.match(before,/\/\/ personal/);assert.match(before,/other/);
  installRelayMcp(options);assert.equal(readFileSync(join(home,'.claude.json'),'utf8'),before);
  assert.equal(readFileSync(join(home,'.codex','config.toml'),'utf8').match(/BEGIN RELAY MCP/g)?.length,1);
  assert.ok(!before.includes('relay_mcp_'));
  writeFileSync(join(home,'.claude.json'),'{"mcpServers":{"relay-projects-test":{"command":"user"}}}');
  assert.throws(()=>installRelayMcp({...options,runtimes:['claude']}),/owned|modified|conflict/i);
  assert.match(readFileSync(join(home,'.claude.json'),'utf8'),/user/);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('real stdio process forwards initialization, discovery and calls to the Python endpoint',async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const home=mkdtempSync(join(tmpdir(),'relay-mcp-process-'));const token='relay_mcp_processsecret';
 const server=await fixtureServer(token);
 try{
  const tokenFile=join(home,'mcp.token');writeFileSync(tokenFile,token,{mode:0o600});
  const config=join(home,'config.json');writeFileSync(config,JSON.stringify({backendUrl:server.url,tokenFile}));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/relay-mcp.js',import.meta.url)),'--config',config]);
  let output='';let stderr='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.end([
   {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},
   {jsonrpc:'2.0',method:'notifications/initialized'},
   {jsonrpc:'2.0',id:2,method:'tools/list'},
   {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'python_defined_tool',arguments:{}}},
  ].map(m=>JSON.stringify(m)).join('\n')+'\n');
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
  assert.equal(code,0,stderr);const replies=output.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(replies.length,3);assert.equal(replies[0].result.serverInfo.name,'python-server');
  assert.deepEqual(replies[1].result.tools,tools);assert.deepEqual(replies[2].result.structuredContent.projects,[{id:'one'}]);
  assert.ok(!output.includes(token));assert.ok(!stderr.includes(token));
 }finally{await server.close();rmSync(home,{recursive:true,force:true});}
});

test('bootstrap preserves credentials and Pi registers only tools discovered from the Python backend',async()=>{
 const {bootstrapRelayMcp}=await import('../src/relay-mcp-bootstrap.js');const {pathToFileURL}=await import('node:url');
 const home=mkdtempSync(join(tmpdir(),'relay-mcp-bootstrap-'));const server=await fixtureServer('relay_mcp_private');
 try{
  let issued=0;
  const options={home,stateDir:join(home,'private'),sandboxId:'computer',backendUrl:server.url,nodeToken:'node-secret',env:{},runtimes:['codex','pi'],fetchFn:(async(_url:unknown,request:RequestInit)=>{
   assert.equal((request.headers as any).Authorization,'Bearer node-secret');
   if(JSON.parse(String(request.body)).existingToken)return Response.json({renewed:false});
   issued++;return Response.json({token:'relay_mcp_private'});
  }) as typeof fetch};
  await bootstrapRelayMcp(options);await bootstrapRelayMcp(options);assert.equal(issued,1);
  assert.equal(statSync(join(home,'private','credentials','mcp.token')).mode&0o777,0o600);
  const config=readFileSync(join(home,'.codex','config.toml'),'utf8');assert.ok(!config.includes('node-secret'));assert.ok(!config.includes('relay_mcp_private'));
  const extensions=join(home,'.pi','agent','extensions');const extension=await import(pathToFileURL(join(extensions,readdirSync(extensions)[0]!)).href);
  const events=new Map<string,()=>Promise<void>>();const registered:any[]=[];
  extension.default({on:(name:string,callback:()=>Promise<void>)=>events.set(name,callback),registerTool:(tool:unknown)=>registered.push(tool)});
  try{
   await events.get('session_start')!();assert.equal(registered.length,1);assert.match(registered[0].name,/python_defined_tool/);
   assert.equal(registered[0].parameters[Symbol.for('TypeBox.Kind')],'Object');
   assert.equal(registered[0].parameters.properties.operations.items.properties.kind[Symbol.for('TypeBox.Kind')],'Union');
  }finally{await events.get('session_shutdown')!();}
 }finally{await server.close();rmSync(home,{recursive:true,force:true});}
});
