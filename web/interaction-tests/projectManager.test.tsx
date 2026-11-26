import {cloneElement,createElement} from 'react';
import {act,fireEvent,render,renderHook,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {beforeEach,expect,it,vi} from 'vitest';
import {ProjectManagerLine} from '../src/components/ProjectManagerLine';
import {ProjectDashboard} from '../src/components/ProjectDashboard';
import {ManagerProposalCard} from '../src/components/ManagerProposalCard';
import {ProjectManagerProposals} from '../src/components/ProjectManagerProposals';
import {useProjectLeadDiscussion} from '../src/hooks/useProjectLeadDiscussion';
import {threadDraftKey} from '../src/hooks/useComposer';
import {SESSIONS_QUERY_KEY} from '../src/hooks/useRelayData';
import {useComposerTargetStore} from '../src/lib/composerTargetStore';
import type {RelayTaskListItem} from '../src/types';

// Floating popups do not open under jsdom; render the topic menu inline.
vi.mock('@/components/ui/dropdown-menu',()=>({
 DropdownMenu:({children}:any)=>createElement('div',null,children),
 DropdownMenuTrigger:({render,disabled}:any)=>cloneElement(render,{disabled}),
 DropdownMenuContent:({children}:any)=>createElement('div',{role:'menu'},children),
 DropdownMenuItem:({children,onClick}:any)=>createElement('div',{role:'menuitem',onClick},children),
}));
const api=vi.hoisted(()=>({get:vi.fn(),proposals:vi.fn(),apply:vi.fn(),dismiss:vi.fn(),open:vi.fn()}));
vi.mock('../src/api-client/project-manager',()=>({getProjectManager:api.get,listThreadProposals:api.proposals,applyManagerProposal:api.apply,dismissManagerProposal:api.dismiss,openProjectLeadConversation:api.open}));
const announce=vi.hoisted(()=>vi.fn());
vi.mock('@/components/ui/DialogProvider',async(original)=>({...await original<typeof import('@/components/ui/DialogProvider')>(),useDialogs:()=>({announce})}));
const nav=vi.hoisted(()=>vi.fn(async()=>{}));
vi.mock('../src/lib/appRoute',async(original)=>({...await original<typeof import('../src/lib/appRoute')>(),navigateToAppPath:nav}));
const proposal={id:'proposal',projectId:'p',threadId:'thread',agentId:'a',runId:'run',state:'pending' as const,revision:1,createdAt:'2026-11-06T00:00:00Z',operations:[
 {id:'0',kind:'create' as const,key:'design',fields:{title:'Design login'},after:[],afterTaskIds:[]},
 {id:'1',kind:'update' as const,taskId:'task',title:'Build login',fields:{priority:'high'},before:{priority:'normal'},after:[],afterTaskIds:[]},
]};
const wrap=(ui:React.ReactNode)=>render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}>{ui}</QueryClientProvider>);
beforeEach(()=>{vi.clearAllMocks();api.proposals.mockResolvedValue({proposals:[]});api.get.mockResolvedValue({project:{id:'p',version:1},manager:{agentId:'a',agentName:'Ada',threadId:null,reason:null,toolsAvailable:true,candidates:[{id:'a',displayName:'Ada'}]},proposals:[]});api.apply.mockResolvedValue({proposal:{...proposal,state:'applied'},tasks:[]});});

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

it('names the Project Lead on the dashboard and offers no discussion unless asked',()=>{
 const onManage=vi.fn();
 wrap(<ProjectManagerLine project={managed({roleLevel:'senior'})} agents={[ada]} onManage={onManage} />);
 const line=screen.getByRole('group',{name:'project.roles.project_manager'});
 expect(line.textContent).toContain('role_levels.senior · project.roles.reviewer');
 expect(screen.queryByRole('button',{name:'project_manager.discuss'})).toBeNull();
 expect(api.get).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('link',{name:'Ada'}));
 expect(nav).toHaveBeenCalledWith('/agents/a');
 fireEvent.click(screen.getByRole('button',{name:'project_manager.change'}));
 expect(onManage).toHaveBeenCalled();
});

it('starts a discussion with the lead, plain or from an everyday topic',()=>{
 const onDiscuss=vi.fn();
 const view=wrap(<ProjectManagerLine project={managed()} agents={[ada]} onDiscuss={onDiscuss} />);
 fireEvent.click(screen.getByRole('button',{name:'project_manager.discuss'}));
 expect(onDiscuss).toHaveBeenLastCalledWith();
 expect(screen.getAllByRole('menuitem').map(item=>item.textContent)).toEqual(
  ['project_manager.quick_update','project_manager.quick_attention','project_manager.quick_next','project_manager.quick_plan']);
 fireEvent.click(screen.getByRole('menuitem',{name:'project_manager.quick_attention'}));
 expect(onDiscuss).toHaveBeenLastCalledWith('attention');
 view.unmount();
 wrap(<ProjectManagerLine project={managed()} agents={[ada]} onDiscuss={onDiscuss} discussing />);
 expect((screen.getByRole('button',{name:'project_manager.discuss'}) as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByRole('button',{name:'project_manager.quick_topics'}) as HTMLButtonElement).disabled).toBe(true);
});

it('offers no discussion with a disabled lead',()=>{
 wrap(<ProjectManagerLine project={managed({enabled:false})} agents={[ada]} onDiscuss={vi.fn()} />);
 expect(screen.queryByRole('button',{name:'project_manager.discuss'})).toBeNull();
});

const owner={id:'u',userId:'u',username:'owner',role:'user'} as any;
const hookWrapper=(client:QueryClient)=>({children}:{children:React.ReactNode})=>
 <QueryClientProvider client={client}>{children}</QueryClientProvider>;

it.each(["apply", "dismiss"] as const)("limits cache invalidation after a proposal %s", async action => {
 const client = new QueryClient();
 const keys = {
  tasks: ["relay", "tasks"], projectTasks: ["relay", "tasks", "p"], otherProject: ["relay", "tasks", "other"],
  dashboard: ["relay", "tasks", "p", "project-dashboard"],
  issues: ["relay", "tasks", "issue-page", "scope=issues&layout=list"],
  board: ["relay", "tasks", "issue-page", "scope=board&layout=board&projectId=p"],
  otherBoard: ["relay", "tasks", "issue-page", "scope=board&layout=board&projectId=other"],
  computer: ["relay", "tasks", "issue-page", "scope=board&layout=list&computerId=device"],
  automations: ["relay", "tasks", "automation-page", "projectId=p", 1],
  thread: ["relay", "tasks", "thread", "thread"], otherThread: ["relay", "tasks", "thread", "other"],
  home: ["relay", "tasks", "home"], nodes: ["relay", "daemon-nodes"],
  notifications: ["relay", "notifications", "u"], changed: ["task-record", "task"], other: ["task-record", "other"],
 };
 for (const key of Object.values(keys)) client.setQueryData(key, {projectId: key === keys.changed ? "p" : "other"});
 api.proposals.mockResolvedValue({proposals: [proposal]});
 api.apply.mockResolvedValue({tasks: [{id: "task"}]});
 api.dismiss.mockResolvedValue({});
 const view = render(<ProjectManagerProposals projectId="p" threadId="thread" readOnly={false} running={false} />,
  {wrapper: hookWrapper(client)});
 try {
  fireEvent.click(await screen.findByRole("button", {name: `project_manager.${action}`}));
  await waitFor(() => expect(api.proposals).toHaveBeenCalledTimes(2));
  const invalidated = Object.entries(keys).filter(([, key]) => client.getQueryState(key)?.isInvalidated).map(([name]) => name);
  expect(invalidated).toEqual(action === "apply" ? ["tasks", "projectTasks", "dashboard", "issues", "board", "thread", "home", "changed"] : []);
 } finally {
  view.unmount();
  client.clear();
 }
});

it('opens separate Lead discussions with their own drafts and the role as the default target',async()=>{
 sessionStorage.clear();
 const client=new QueryClient({defaultOptions:{mutations:{retry:false}}});
 const invalidate=vi.spyOn(client,'invalidateQueries');
 let finishFirst!: (value: {threadId:string;agentId:string})=>void;
 const firstRequest=new Promise<{threadId:string;agentId:string}>(resolve=>{finishFirst=resolve;});
 api.open.mockReturnValueOnce(firstRequest)
  .mockResolvedValueOnce({threadId:'plain-thread',agentId:'a'});
 const onOpenThread=vi.fn();
 const {result}=renderHook(()=>useProjectLeadDiscussion({projectId:'p',currentUser:owner,onOpenThread}),{wrapper:hookWrapper(client)});
 act(()=>result.current.discuss('next'));
 await waitFor(()=>expect(result.current.pending).toBe(true));
 act(()=>result.current.discuss());
 expect(api.open).toHaveBeenCalledOnce();
 finishFirst({threadId:'topic-thread',agentId:'a'});
 await waitFor(()=>expect(onOpenThread).toHaveBeenLastCalledWith('topic-thread'));
 await waitFor(()=>expect(result.current.pending).toBe(false));
 act(()=>result.current.discuss());
 await waitFor(()=>expect(onOpenThread).toHaveBeenLastCalledWith('plain-thread'));
 expect(api.open.mock.calls).toEqual([['p'],['p']]);
 expect(invalidate.mock.calls).toEqual([
  [{queryKey:SESSIONS_QUERY_KEY,exact:true}],
  [{queryKey:['project-discussions','p']}],
  [{queryKey:SESSIONS_QUERY_KEY,exact:true}],
  [{queryKey:['project-discussions','p']}],
 ]);
 for(const threadId of ['topic-thread','plain-thread']) {
  expect(useComposerTargetStore.getState().threadPicks[threadId]).toBeUndefined();
 }
 expect(sessionStorage.getItem(`relay-web.draft:${threadDraftKey(owner,'topic-thread')}`)).toBe('project_manager.prompt_next');
 expect(sessionStorage.getItem(`relay-web.draft:${threadDraftKey(owner,'plain-thread')}`)).toBeNull();
});

it('never overwrites a draft the person already left in the lead Thread',async()=>{
 sessionStorage.clear();
 const key=`relay-web.draft:${threadDraftKey(owner,'lead-thread')}`;
 sessionStorage.setItem(key,'my own question');
 api.open.mockResolvedValue({threadId:'lead-thread',agentId:'a'});
 const onOpenThread=vi.fn();
 const {result}=renderHook(()=>useProjectLeadDiscussion({projectId:'p',currentUser:owner,onOpenThread}),{wrapper:hookWrapper(new QueryClient())});
 act(()=>result.current.discuss('plan'));
 await waitFor(()=>expect(onOpenThread).toHaveBeenCalled());
 expect(sessionStorage.getItem(key)).toBe('my own question');
});

it('reports a failed open and stays on the dashboard',async()=>{
 api.open.mockRejectedValue(new Error('manager_unconfigured'));
 const onOpenThread=vi.fn();
 const {result}=renderHook(()=>useProjectLeadDiscussion({projectId:'p',currentUser:owner,onOpenThread}),{wrapper:hookWrapper(new QueryClient({defaultOptions:{mutations:{retry:false}}}))});
 act(()=>result.current.discuss());
 await waitFor(()=>expect(announce).toHaveBeenCalledWith(expect.objectContaining({message:'errors.open_project_lead',tone:'error'})));
 expect(onOpenThread).not.toHaveBeenCalled();
 await waitFor(()=>expect(result.current.pending).toBe(false));
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
  await waitFor(()=>expect(api.proposals).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.proposals).toHaveBeenCalledTimes(1);
  view.rerender(ui(true));
  await vi.advanceTimersByTimeAsync(10500);
  expect(api.get).not.toHaveBeenCalled();
  const whileRunning=api.proposals.mock.calls.length;
  expect(whileRunning).toBeGreaterThan(1);
  api.proposals.mockResolvedValue({project:{id:'p',version:1},manager:{agentId:'a',agentName:'Ada',threadId:'thread',reason:null,toolsAvailable:true,candidates:[]},proposals:[proposal]});
  view.rerender(ui(false));
  expect(await screen.findByRole('region',{name:'project_manager.changes'})).toBeTruthy();
  const afterEnd=api.proposals.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.proposals).toHaveBeenCalledTimes(afterEnd);
 }finally{vi.useRealTimers();}
});

it('keeps a pending proposal inline with its draft and no fold control',()=>{
 wrap(<ManagerProposalCard projectId="p" proposal={proposal} disabled={false} onChanged={vi.fn()} />);
 expect(screen.queryByRole('button',{name:/^project_manager\.changes/})).toBeNull();
 expect(screen.getByRole('heading',{name:'project_manager.changes'})).toBeTruthy();
 expect(screen.getByRole('textbox',{name:'project_manager.field_title'})).toBeTruthy();
 expect(screen.getByRole('button',{name:'project_manager.apply'})).toBeTruthy();
});

it.each(['applied','dismissed','superseded','expired'] as const)('shows a %s proposal as one line that says how it ended',state=>{
 wrap(<ManagerProposalCard projectId="p" proposal={{...proposal,state}} disabled={false} onChanged={vi.fn()} />);
 expect(screen.getByRole('status').textContent).toBe(`project_manager.proposal_${state}`);
 expect(screen.queryByRole('group')).toBeNull();
 expect(screen.queryByRole('button')).toBeNull();
});

it('shrinks a proposal to its outcome once it is applied',async()=>{
 const {ProjectManagerProposals}=await import('../src/components/ProjectManagerProposals');
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 api.proposals.mockResolvedValue({proposals:[proposal]});
 render(<QueryClientProvider client={client}><ProjectManagerProposals projectId="p" threadId="thread" readOnly={false} running={false} /></QueryClientProvider>);
 await screen.findByRole('region',{name:'project_manager.changes'});
 expect(screen.getAllByRole('group').length).toBeGreaterThan(0);
 api.proposals.mockResolvedValue({proposals:[{...proposal,state:'applied'}]});
 await act(async()=>{await client.invalidateQueries({queryKey:['project-manager','p']});});
 await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('project_manager.proposal_applied'));
 expect(screen.queryByRole('group')).toBeNull();
});
