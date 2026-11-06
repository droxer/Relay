import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,expect,it,vi} from 'vitest';
import {ProjectManagerAgentCard} from '../src/components/ProjectManagerAgentCard';
import {ManagerProposalCard} from '../src/components/ManagerProposalCard';

const api=vi.hoisted(()=>({get:vi.fn(),open:vi.fn(),apply:vi.fn(),dismiss:vi.fn()}));
vi.mock('../src/api-client/project-manager',()=>({getProjectManager:api.get,openManagerConversation:api.open,applyManagerProposal:api.apply,dismissManagerProposal:api.dismiss}));
const proposal={id:'proposal',projectId:'p',threadId:'thread',agentId:'a',runId:'run',state:'pending' as const,revision:1,createdAt:'2026-11-06T00:00:00Z',operations:[
 {id:'0',kind:'create' as const,key:'design',fields:{title:'Design login'},after:[],afterTaskIds:[]},
 {id:'1',kind:'update' as const,taskId:'task',title:'Build login',fields:{priority:'high'},before:{priority:'normal'},after:[],afterTaskIds:[]},
]};
const wrap=(ui:React.ReactNode)=>render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}>{ui}</QueryClientProvider>);
beforeEach(()=>{vi.clearAllMocks();api.get.mockResolvedValue({project:{id:'p',version:1},manager:{agentId:'a',agentName:'Ada',threadId:null,reason:null,toolsAvailable:true,candidates:[{id:'a',displayName:'Ada'}]},proposals:[]});api.open.mockResolvedValue({threadId:'thread'});api.apply.mockResolvedValue({proposal:{...proposal,state:'applied'},tasks:[]});});

it('shows the real Agent with its Project Manager role and opens a normal conversation',async()=>{
 const onOpen=vi.fn();wrap(<ProjectManagerAgentCard projectId="p" onOpenThread={onOpen} onManageRole={vi.fn()} />);
 expect((await screen.findByRole('link',{name:'Ada'})).getAttribute('href')).toBe('/agents/a');
 expect(screen.queryByRole('complementary')).toBeNull();
 expect(api.open).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'project_manager.chat'}));
 await waitFor(()=>expect(onOpen).toHaveBeenCalledWith('thread'));
 expect(api.open).toHaveBeenCalledWith('p');
});

it('allows editing and selecting proposal items before applying the exact batch',async()=>{
 wrap(<ManagerProposalCard projectId="p" proposal={proposal} disabled={false} onChanged={vi.fn()} />);
 fireEvent.change(screen.getByRole('textbox',{name:'project_manager.field_title'}),{target:{value:'Design sign in'}});
 fireEvent.click(screen.getByRole('checkbox',{name:/Build login/}));
 fireEvent.click(screen.getByRole('button',{name:'project_manager.apply'}));
 await waitFor(()=>expect(api.apply).toHaveBeenCalledWith('p','proposal',expect.objectContaining({operationIds:['0'],fields:{'0':{title:'Design sign in'}},expectedRevision:1,idempotencyKey:expect.any(String)})));
});

it('keeps failed apply visible and retries with the same key',async()=>{
 api.apply.mockRejectedValue(new Error('Task changed; refresh the proposal.'));
 wrap(<ManagerProposalCard projectId="p" proposal={proposal} disabled={false} onChanged={vi.fn()} />);
 fireEvent.click(screen.getByRole('button',{name:'project_manager.apply'}));await screen.findByRole('alert');
 fireEvent.click(screen.getByRole('button',{name:'project_manager.apply'}));await waitFor(()=>expect(api.apply).toHaveBeenCalledTimes(2));
 expect(api.apply.mock.calls[0][2].idempotencyKey).toBe(api.apply.mock.calls[1][2].idempotencyKey);
});

it('polls for staged proposals only while the thread runs, and reads once when it ends',async()=>{
 const {ProjectManagerProposals}=await import('../src/components/ProjectManagerProposals');
 vi.useFakeTimers({shouldAdvanceTime:true});
 try{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const ui=(running:boolean)=><QueryClientProvider client={client}><ProjectManagerProposals projectId="p" threadId="thread" readOnly={false} running={running} /></QueryClientProvider>;
  const view=render(ui(false));
  await waitFor(()=>expect(api.get).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.get).toHaveBeenCalledTimes(1);
  view.rerender(ui(true));
  await vi.advanceTimersByTimeAsync(4500);
  const whileRunning=api.get.mock.calls.length;
  expect(whileRunning).toBeGreaterThan(1);
  api.get.mockResolvedValue({project:{id:'p',version:1},manager:{agentId:'a',agentName:'Ada',threadId:'thread',reason:null,toolsAvailable:true,candidates:[]},proposals:[proposal]});
  view.rerender(ui(false));
  expect(await screen.findByRole('region',{name:'project_manager.changes'})).toBeTruthy();
  const afterEnd=api.get.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.get).toHaveBeenCalledTimes(afterEnd);
 }finally{vi.useRealTimers();}
});
