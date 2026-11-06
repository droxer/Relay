import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMcpReconciler, bootstrapRelayMcp} from '../src/relay-mcp-bootstrap.js';
import {managedMcpInvoker} from '../src/relay-mcp-managed.js';
import {createProjectManagerBridge} from '../src/project-manager.js';

test('managed MCP pins Project and backend and cannot fall back to the Computer credential',async()=>{
 const root=mkdtempSync(join(tmpdir(),'relay-scoped-mcp-'));const calls:unknown[]=[];
 const bridge=createProjectManagerBridge(root,async(tool,args)=>{calls.push([tool,args]);return {project:{id:'a'},agentId:'manager',runId:'run'};});
 try{
  const context={backendUrl:'https://relay.example',projectId:'a',bridgePath:join(root,bridge.toolPath)};
  const invoke=managedMcpInvoker('https://relay.example',JSON.stringify(context));
  assert.equal((await invoke('overview',{projectId:'a'}) as any).runId,'run');
  await assert.rejects(invoke('overview',{projectId:'b'}),/scope/);
  assert.equal(calls.length,1);
  await assert.rejects(managedMcpInvoker('https://other.example',JSON.stringify(context))('overview',{projectId:'a'}),/scope|disabled/);
  await assert.rejects(managedMcpInvoker('https://relay.example','{"disabled":true}')('projects',{}),/disabled/);
 }finally{await bridge.dispose();rmSync(root,{recursive:true,force:true});}
});

test('MCP reconciliation retries failure and installs newly ready runtimes without repeating successful work',async()=>{
 let now=0;let attempts=0;let fail=true;
 const reconcile=createMcpReconciler(async(runtimes)=>{attempts++;if(fail)throw new Error('temporary');return [...runtimes];},()=>now);
 assert.equal((await reconcile(['codex'])).status,'retrying');
 await reconcile(['codex']);assert.equal(attempts,1);
 now=31_000;fail=false;assert.equal((await reconcile(['codex'])).status,'ready');
 await reconcile(['codex']);assert.equal(attempts,2);
 await reconcile(['codex','claude']);assert.equal(attempts,3);
 now+=16*60_000;await reconcile(['codex','claude']);assert.equal(attempts,4);
});

test('bootstrap checks an existing credential, persists renewal and reports revocation without deleting it',async()=>{
 const home=mkdtempSync(join(tmpdir(),'relay-mcp-renew-'));let state='initial';let requests=0;
 const options={home,stateDir:join(home,'state'),sandboxId:'computer',backendUrl:'https://relay.example',nodeToken:'node',runtimes:['codex'],env:{},fetchFn:(async(_url:unknown,request:RequestInit)=>{
  requests++;const body=JSON.parse(String(request.body));
  if(state==='initial'){assert.equal(body.existingToken,undefined);return Response.json({token:'relay_mcp_first'});}
  assert.equal(body.existingToken,state==='renew'?'relay_mcp_first':'relay_mcp_second');
  if(state==='renew')return Response.json({token:'relay_mcp_second',renewed:true});
  return Response.json({detail:'mcp_token_revoked'},{status:403});
 }) as typeof fetch};
 try{
  await bootstrapRelayMcp(options);state='renew';await bootstrapRelayMcp(options);
  const path=join(home,'state','credentials','mcp.token');assert.equal(readFileSync(path,'utf8').trim(),'relay_mcp_second');
  state='revoked';await assert.rejects(bootstrapRelayMcp(options),/revoked/);
  assert.equal(readFileSync(path,'utf8').trim(),'relay_mcp_second');assert.equal(requests,3);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('daemon proxy issues a command-bound token and uses it for every Project operation',async()=>{
 const {createRunMcpProxy}=await import('../src/relay-mcp-managed.js');
 let issued=0;const calls:string[]=[];
 const invoke=createRunMcpProxy({backendUrl:'https://relay.example',sandboxId:'node',nodeToken:'node-secret',commandId:'command',leaseId:'lease',projectId:'a',signal:new AbortController().signal,fetchFn:(async(url:unknown,request:RequestInit)=>{
  const path=new URL(String(url)).pathname;calls.push(path);
  if(path.endsWith('/mcp-token')){
   issued++;assert.deepEqual(JSON.parse(String(request.body)),{commandId:'command',leaseId:'lease'});
   assert.equal((request.headers as any).Authorization,'Bearer node-secret');
   return Response.json({token:'relay_mcp_run'});
  }
  assert.equal((request.headers as any).Authorization,'Bearer relay_mcp_run');
  if(request.body)assert.equal(JSON.parse(String(request.body)).arguments.projectId,'a');
  return Response.json({agentId:'manager',runId:'run'});
 }) as typeof fetch});
 await assert.rejects(invoke('overview',{projectId:'b'}),/scope/);assert.equal(calls.length,0);
 await invoke('overview',{});await invoke('propose',{operations:[]});assert.equal(issued,1);
 assert.deepEqual(calls,['/api/v1/daemon-nodes/node/mcp-token','/api/v1/mcp/projects/a/tools','/api/v1/mcp/projects/a/tools']);
});

test('installer recovers a dead-owner lock and keeps an active installer exclusive',async()=>{
 const {installRelayMcp}=await import('../src/relay-mcp-install.js');
 const {mkdirSync,writeFileSync}=await import('node:fs');
 const home=mkdtempSync(join(tmpdir(),'relay-mcp-lock-'));const lock=join(home,'.relay','mcp','install.lock');
 const options={home,runtimes:['codex'],configFile:join(home,'config.json'),serverName:'relay-test'};
 try{
  mkdirSync(lock,{recursive:true});writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:2147483647}));
  installRelayMcp(options);assert.match(readFileSync(join(home,'.codex','config.toml'),'utf8'),/env_vars = \["RELAY_MCP_RUN_CONTEXT"\]/);
  mkdirSync(lock);writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid}));
  assert.throws(()=>installRelayMcp(options),/active/);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('managed runtime configuration does not depend on or revive a standalone credential',async()=>{
 const {configureRelayMcp}=await import('../src/relay-mcp-bootstrap.js');
 const {existsSync}=await import('node:fs');
 const home=mkdtempSync(join(tmpdir(),'relay-managed-install-'));
 try{
  configureRelayMcp({home,stateDir:join(home,'state'),sandboxId:'computer',backendUrl:'https://relay.example',runtimes:['codex','claude'],env:{}});
  assert.equal(existsSync(join(home,'state','credentials','mcp.token')),false);
  assert.match(readFileSync(join(home,'.codex','config.toml'),'utf8'),/env_vars = \["RELAY_MCP_RUN_CONTEXT"\]/);
  assert.equal(JSON.parse(readFileSync(join(home,'.claude.json'),'utf8')).mcpServers[Object.keys(JSON.parse(readFileSync(join(home,'.claude.json'),'utf8')).mcpServers)[0]!].env.RELAY_MCP_RUN_CONTEXT,'${RELAY_MCP_RUN_CONTEXT:-}');
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('real managed stdio server cannot read a persistent token or cross its Project',async()=>{
 const {spawn}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const {writeFileSync}=await import('node:fs');
 const home=mkdtempSync(join(tmpdir(),'relay-managed-stdio-'));const calls:string[]=[];
 const bridge=createProjectManagerBridge(home,async(tool)=>{calls.push(tool);return {project:{id:'a'},agentId:'manager',runId:'run'};});
 try{
  const config=join(home,'config.json');writeFileSync(config,JSON.stringify({backendUrl:'https://relay.example',tokenFile:join(home,'must-not-be-read')}));
  const context=JSON.stringify({backendUrl:'https://relay.example',projectId:'a',bridgePath:join(home,bridge.toolPath)});
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/relay-mcp.js',import.meta.url)),'--config',config],{env:{...process.env,RELAY_MCP_RUN_CONTEXT:context}});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.end(['a','b'].map((projectId,id)=>JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'relay_project_overview',arguments:{projectId}}})).join('\n')+'\n');
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
  assert.equal(code,0,stderr);const results=output.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(results[0].result.structuredContent.agentId,'manager');assert.equal(results[1].result.isError,true);assert.deepEqual(calls,['overview']);
 }finally{await bridge.dispose();rmSync(home,{recursive:true,force:true});}
});
