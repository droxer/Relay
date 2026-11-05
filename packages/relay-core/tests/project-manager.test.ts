import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AGENT_NAMES, getAgent, initialAgentState, agentTaskPrompt} from '../src/index.js';

test('all runtime commands receive the same live project manager tool contract', () => {
  const state={...initialAgentState('What should we do next?'), project_manager:{projectId:'p',agentId:'a',bindingRevision:1,toolCommand:'node ".relay/manager-test/tool.cjs"'}};
  const prompt=agentTaskPrompt(state);
  assert.match(prompt,/EVERY turn read fresh project data/);
  assert.match(prompt,/owner reviews and applies/);
  assert.match(prompt,/taskId,fields/);
  for(const kind of AGENT_NAMES) {
    const command=getAgent(kind).buildCommand(state);
    assert.match(command,/Relay project manager/);
    assert.match(command,/manager-test\/tool.cjs/);
  }
});
