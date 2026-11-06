import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,expect,it,vi} from 'vitest';
import {ProjectManagerLine} from '../src/components/ProjectManagerLine';
import {ProjectDashboard} from '../src/components/ProjectDashboard';
import {ManagerProposalCard} from '../src/components/ManagerProposalCard';
import type {RelayTaskListItem} from '../src/types';

const api=vi.hoisted(()=>({get:vi.fn(),apply:vi.fn(),dismiss:vi.fn()}));
vi.mock('../src/api-client/project-manager',()=>({getProjectManager:api.get,applyManagerProposal:api.apply,dismissManagerProposal:api.dismiss}));
const nav=vi.hoisted(()=>vi.fn(async()=>{}));
vi.mock('../src/lib/appRoute',async(original)=>({...await original<typeof import('../src/lib/appRoute')>(),navigateToAppPath:nav}));
const proposal={id:'proposal',projectId:'p',threadId:'thread',agentId:'a',runId:'run',state:'pending' as const,revision:1,createdAt:'2026-11-06T00:00:00Z',operations:[
 {id:'0',kind:'create' as const,key:'design',fields:{title:'Design login'},after:[],afterTaskIds:[]},
 {id:'1',kind:'update' as const,taskId:'task',title:'Build login',fields:{priority:'high'},before:{priority:'normal'},after:[],afterTaskIds:[]},
]};
const wrap=(ui:React.ReactNode)=>render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}>{ui}</QueryClientProvider>);
beforeEach(()=>{vi.clearAllMocks();api.get.mockResolvedValue({project:{id:'p',version:1},manager:{agentId:'a',agentName:'Ada',threadId:null,reason:null,toolsAvailable:true,candidates:[{id:'a',displayName:'Ada'}]},proposals:[]});api.apply.mockResolvedValue({proposal:{...proposal,state:'applied'},tasks:[]});});

const ada={id:'a',displayName:'Ada',executorKind:'codex',enabled:true,availability:'ready',placements:[]} as any;
const managed=(member:Record<string,unknown>={})=>({id:'p',version:1,leadAgentId:'a',members:[{agentId:'a',role:'reviewer',responsibilities:'Review',enabled:true,projectManager:true,...member}]}) as any;

it.each([false,true])('keeps the Project Lead visible on the dashboard with tasks=%s',(hasTasks)=>{
 const tasks=hasTasks?[{id:'task',title:'Build login',status:'backlog',priority:'normal',createdAt:'2026-11-06T00:00:00Z',updatedAt:'2026-11-06T00:00:00Z'} as RelayTaskListItem]:[];
 const onManage=vi.fn();
 const view=wrap(<ProjectDashboard tasks={tasks} onOpenRecord={vi.fn()} onOpenBoard={vi.fn()}
  steward={<ProjectManagerLine project={managed()} agents={[ada]} onManage={onManage} />} />);
 const lead=screen.getByRole('group',{name:'project.roles.project_manager'});
 expect(lead.querySelector('a')?.textContent).toBe('Ada');
 expect(view.container.querySelector('.project-dashboard')?.firstElementChild).toBe(lead);
 expect(hasTasks?screen.getByRole('group',{name:'backlog.metrics'}):screen.getByText('project.dashboard_empty')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'project_manager.change'}));
 expect(onManage).toHaveBeenCalledOnce();
});

it('names the Project Lead on the dashboard without a chat to open',()=>{
 const onManage=vi.fn();
 wrap(<ProjectManagerLine project={managed()} agents={[ada]} onManage={onManage} />);
 const line=screen.getByRole('group',{name:'project.roles.project_manager'});
 expect(line.textContent).toContain('project.roles.reviewer');
 expect(screen.queryByRole('button',{name:'project_manager.chat'})).toBeNull();
 expect(api.get).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('link',{name:'Ada'}));
 expect(nav).toHaveBeenCalledWith('/agents/a');
 fireEvent.click(screen.getByRole('button',{name:'project_manager.change'}));
 expect(onManage).toHaveBeenCalled();
});

it('shows the lead even when a legacy manager flag points to another agent',()=>{
 const project={...managed(),leadAgentId:'b',members:[...managed().members,{agentId:'b',role:'implementer',enabled:true,responsibilities:'Build'}]};
 wrap(<ProjectManagerLine project={project} agents={[ada,{...ada,id:'b',displayName:'Bea'}]} />);
 expect(screen.getByRole('link',{name:'Bea'})).toBeTruthy();
 expect(screen.queryByRole('link',{name:'Ada'})).toBeNull();
});

it('says when the role is open, and when its holder cannot work',()=>{
 const view=wrap(<ProjectManagerLine project={{id:'p',version:1,members:[]} as any} agents={[]} onManage={vi.fn()} />);
 expect(screen.getByText('project_manager.unassigned_role')).toBeTruthy();
 expect(screen.getByRole('button',{name:'project_manager.assign_role'})).toBeTruthy();
 view.unmount();
 wrap(<ProjectManagerLine project={managed({enabled:false})} agents={[ada]} />);
 expect(screen.getByText('project.member_disabled')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'project_manager.change'})).toBeNull();
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
