import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AGENT_NAMES, getAgent, initialAgentState, agentTaskPrompt, type AgentName, type AgentState} from '../src/index.js';

function withPermissionAdapter(agent: AgentName, state: AgentState): AgentState {
  const prompts = getAgent(agent).permissionPrompts;
  return prompts.kind === 'adapter' ? {
    ...state,
    permission_prompt: {adapter: prompts.adapter, command: process.execPath, args: ['adapter.js'], env: {}},
  } : state;
}

test('all runtime commands receive the same live project lead tool contract', () => {
  const state={...initialAgentState('What should we do next?'), project_manager:{projectId:'p',agentId:'a',bindingRevision:1,toolCommand:'node ".relay/manager-test/tool.cjs"'}};
  const prompt=agentTaskPrompt(state);
  assert.match(prompt,/EVERY turn read fresh project data/);
  assert.match(prompt,/owner reviews and applies/);
  assert.match(prompt,/taskId,fields/);
  for(const kind of AGENT_NAMES) {
    const command=getAgent(kind).buildCommand(withPermissionAdapter(kind,state));
    assert.match(command,/Relay project lead/);
    assert.match(command,/manager-test\/tool.cjs/);
  }
});

test('every runtime receives daemon-owned managed MCP context outside the prompt',async()=>{
  const {runAgentNode}=await import('../src/index.js');
  const context=JSON.stringify({disabled:true});
  for(const agent of AGENT_NAMES){
    let invoked=false;
    await runAgentNode(agent,withPermissionAdapter(agent,initialAgentState('A normal run')),{runtimeEnv:{RELAY_MCP_RUN_CONTEXT:context},execStream:async(command,args,options)=>{
      invoked=true;assert.equal(options?.env?.RELAY_MCP_RUN_CONTEXT,context);
      assert.ok(!command.includes(context));
      return {exit_code:0,stdout:'',stderr:''};
    }});
    assert.equal(invoked,true);
  }
});

test('a roster member gets the read-only project contract, never the propose tool', () => {
  const state={...initialAgentState('Build the page'), project_reader:{projectId:'p',agentId:'b',bindingRevision:1,toolCommand:'node ".relay/manager-test/tool.cjs"'}};
  const prompt=agentTaskPrompt(state);
  assert.match(prompt,/Relay project records/);
  assert.match(prompt,/relay_list_tasks/);
  assert.match(prompt,/you cannot change its work/);
  assert.doesNotMatch(prompt,/relay_propose_task_changes|Relay project lead/);
});

test('every runtime gets standalone Task and Automation tools independently of Project access', () => {
  const state = {...initialAgentState('Organize my work'), relay_mcp:{toolCommand:'node ".relay/manager-test/tool.cjs"'}};
  for (const agent of AGENT_NAMES) {
    const command = getAgent(agent).buildCommand(withPermissionAdapter(agent, state));
    assert.match(command, /relay_create_task/);
    assert.match(command, /relay_create_automation/);
    assert.match(command, /only its Project Lead/);
    assert.match(command, /Omit projectId for standalone work/);
    assert.match(command, /manager-test\/tool.cjs/);
  }
});
