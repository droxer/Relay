import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {forwardMcp} from '../src/relay-mcp.js';

test('local MCP bridge forwards protocol and future Python-owned tools without a local catalog',async()=>{
 const home=mkdtempSync(join(tmpdir(),'relay-python-bridge-'));const tokenFile=join(home,'token');writeFileSync(tokenFile,'relay_mcp_bridge');
 const messages:unknown[]=[];
 const server=createServer(async(req,res)=>{
  assert.equal(req.url,'/api/v1/mcp');assert.equal(req.headers.authorization,'Bearer relay_mcp_bridge');
  let raw='';for await(const chunk of req)raw+=chunk;const message=JSON.parse(raw);messages.push(message);
  if(message.id===undefined){res.writeHead(202).end();return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'?{protocolVersion:'2025-11-25',serverInfo:{name:'Python-owned'}}:{pythonOwns:message.method}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const forward=forwardMcp(`http://127.0.0.1:${(server.address() as any).port}`,tokenFile);
  const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'local',version:'1'}}};
  assert.equal((await forward(initialize) as any).result.serverInfo.name,'Python-owned');
  const future={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'future_python_tool',arguments:{newField:'accepted'}}};
  assert.deepEqual((await forward(future) as any).result,{pythonOwns:'tools/call'});
  assert.equal(await forward({jsonrpc:'2.0',method:'notifications/initialized'}),undefined);
  assert.deepEqual(messages,[initialize,future,{jsonrpc:'2.0',method:'notifications/initialized'}]);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true,force:true});}
});
