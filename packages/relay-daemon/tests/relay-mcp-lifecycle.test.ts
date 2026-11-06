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
