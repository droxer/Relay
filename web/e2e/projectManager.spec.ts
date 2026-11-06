import {expect,test} from '@playwright/test';

for (const variant of [{mobile:false,zh:false},{mobile:true,zh:false},{mobile:true,zh:true}]) {
  const {mobile,zh}=variant;
  test(`Project Manager is an Agent role with a normal Thread (${mobile ? 'mobile' : 'desktop'} ${zh ? 'Chinese' : 'English'})`, async ({page}) => {
    await page.setViewportSize(mobile ? {width:390,height:844} : {width:1440,height:900});
    const stamp='2026-11-06T00:00:00Z';
    const agent={id:'ada',displayName:'Ada',executorKind:'codex',defaultRole:'implementer',supervisorUserId:'u',enabled:true,availability:'ready',version:1,skills:[],placements:[{id:'placement',agentId:'ada',computerId:'computer',daemonNodeId:'node',desiredState:'active',status:'ready'}],createdAt:stamp,updatedAt:stamp};
    const project={id:'launch',name:'Autumn launch',ownerUserId:'u',computerId:'computer',enabled:true,members:[{agentId:'ada',role:'project_manager',enabled:true,responsibilities:'Coordinate the launch'}],managerAgentId:'ada',managerThreadId:null as string|null,leadAgentId:'ada',version:1,workspaceLayout:'project',workspaceSubpath:'projects/launch',createdAt:stamp,updatedAt:stamp};
    const session={id:'manager-thread',taskGoal:'Autumn launch · Project Manager',projectId:'launch',ownerUserId:'u',ownerAgentId:'ada',participantAgentIds:['ada'],participants:['human'],status:'completed',phase:'done',events:[],agentRuns:[],artifacts:[],decisions:[],collaborationRounds:[],createdAt:stamp,updatedAt:stamp,execution:{phase:'terminal',executionConfirmed:true,deletionRequested:false,canDelete:true,blockingReason:null,lastConfirmedAt:stamp,nextRecoveryAt:null}};
    let opened=false; let sent=0;
    const applications: unknown[]=[];const tasks: Array<Record<string,unknown>>=[];
    const proposal={id:'proposal',projectId:'launch',threadId:'manager-thread',agentId:'ada',runId:'run',state:'pending',revision:1,createdAt:stamp,operations:[{id:'0',kind:'create',key:'design',fields:{title:'Design login',description:'List accepted login states.',priority:'high'},after:[],afterTaskIds:[]}]};
    await page.route('**/api/**', async route => {
      const path=new URL(route.request().url()).pathname;const method=route.request().method();
      let body: unknown={sessions:opened?[session]:[],agents:[agent],teams:[],nodes:[],projects:[project],tasks,sandboxes:[],skills:[]};
      if(path.endsWith('/auth/me')) body={authenticated:true,user:{id:'u',userId:'u',username:'Fei',role:'user',theme:zh?'dark':'light',language:zh?'zh-CN':'en'}};
      if(path.endsWith('/manager')) body={project,manager:{agentId:'ada',agentName:'Ada',threadId:opened?'manager-thread':null,toolsAvailable:true,reason:null,candidates:[{id:'ada',displayName:'Ada'}]},proposals:opened?[proposal]:[]};
      if(path.endsWith('/manager/conversation') && method==='POST') {opened=true;project.managerThreadId='manager-thread';body={threadId:'manager-thread'};}
      if(path.endsWith('/threads/manager-thread')) body=session;
      if(path.endsWith('/messages') && method==='POST') {sent++;body=session;}
      if(path.endsWith('/proposal/apply')) {const input=route.request().postDataJSON();applications.push(input);tasks.push({id:'created-task',title:input.fields['0'].title,projectId:'launch',status:'backlog',priority:'high',isRoutine:false,ownerUserId:'u',linkedSessionIds:[],createdAt:stamp,updatedAt:stamp});proposal.state='applied';proposal.revision=2;body={proposal,tasks};}
      if(path.endsWith('/events')) {await route.fulfill({status:200,contentType:'text/event-stream',body:''});return;}
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto('/projects/launch');
    const card=page.locator('.project-manager-agent');await expect(card.getByRole('link',{name:'Ada'})).toBeVisible();
    await expect(card).toContainText(zh?'项目经理':'Project Manager');
    await card.getByRole('button',{name:zh?'对话':'Chat',exact:true}).click();
    await expect(page).toHaveURL(/\/threads\/manager-thread/);expect(sent).toBe(0);
    await expect(page.locator('.project-manager-panel')).toHaveCount(0);
    if (!mobile) await expect(page.getByRole('complementary',{name:'Threads',exact:true})).toContainText('Autumn launch');
    const title=page.getByRole('textbox',{name:zh?'标题':'Title',exact:true});
    await expect(title).toHaveValue('Design login');await page.reload();await expect(title).toHaveValue('Design login');
    await title.fill('Design sign in');
    await page.screenshot({path:`../output/playwright/project-manager-${mobile?'mobile':'desktop'}-${zh?'zh-dark':'en'}.png`,fullPage:true});
    await page.getByRole('button',{name:zh?'应用变更':'Apply changes',exact:true}).click();
    await expect(page.getByText(zh?'已应用变更':'Changes applied',{exact:true})).toBeVisible();
    expect(applications).toHaveLength(1);expect(tasks[0].status).toBe('backlog');expect(tasks[0].title).toBe('Design sign in');
  });
}

test('manager handover replaces a saved target when reopening the normal Thread',async({page})=>{
 const stamp='2026-11-06T00:00:00Z';
 const agents=['ada','bea'].map(id=>({id,displayName:id==='ada'?'Ada':'Bea',executorKind:id==='ada'?'codex':'claude',defaultRole:'implementer',supervisorUserId:'u',enabled:true,availability:'ready',version:1,skills:[],placements:[{id:`p-${id}`,agentId:id,computerId:'computer',daemonNodeId:'node',desiredState:'active',status:'ready'}],createdAt:stamp,updatedAt:stamp}));
 const project={id:'launch',name:'Launch',ownerUserId:'u',computerId:'computer',enabled:true,members:[{agentId:'ada',role:'planner',responsibilities:'Plan',enabled:true},{agentId:'bea',role:'project_manager',responsibilities:'Coordinate',enabled:true}],managerAgentId:'bea',managerThreadId:'manager-thread',leadAgentId:'ada',version:3,workspaceLayout:'project',workspaceSubpath:'projects/launch',createdAt:stamp,updatedAt:stamp};
 const session={id:'manager-thread',taskGoal:'Launch · Project Manager',projectId:'launch',ownerUserId:'u',ownerAgentId:'bea',participantAgentIds:['ada','bea'],participants:['human'],computerId:'computer',daemonNodeId:'node',status:'completed',phase:'done',agentRuns:[],events:[],artifacts:[],decisions:[],collaborationRounds:[],createdAt:stamp,updatedAt:stamp,execution:{phase:'terminal',executionConfirmed:true,deletionRequested:false,canDelete:true,blockingReason:null,lastConfirmedAt:stamp,nextRecoveryAt:null}};
 const node={id:'node',userId:'u',workspaceId:'host',computerId:'computer',name:'Computer',activeRuns:[],online:true,stale:false,status:'ready',agents:{codex:'ready',claude:'ready'},capabilities:['thread-workspaces','project-workspaces','project-manager','project-manager-mcp']};
 const sent:unknown[]=[];
 await page.addInitScript(()=>localStorage.setItem('relay-web.threadComposerPicks',JSON.stringify({'manager-thread':{kind:'agent',agent:{id:'ada',executorKind:'codex'}}})));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  let body:unknown={sessions:[session],agents,projects:[project],nodes:[node],teams:[],tasks:[],skills:[],sandboxes:[]};
  if(path.endsWith('/auth/me'))body={authenticated:true,user:{id:'u',userId:'u',username:'Fei',role:'user',theme:'light',language:'en'}};
  if(path.endsWith('/threads/manager-thread'))body=session;
  if(path.endsWith('/manager'))body={project,manager:{agentId:'bea',agentName:'Bea',threadId:'manager-thread',reason:null,toolsAvailable:true,candidates:agents},proposals:[]};
  if(path.endsWith('/messages')&&route.request().method()==='POST'){sent.push(route.request().postDataJSON());body=session;}
  if(path.endsWith('/events')){await route.fulfill({status:200,contentType:'text/event-stream',body:''});return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('/threads/manager-thread');
 const composer=page.getByRole('textbox',{name:'Message Bea',exact:true});await expect(composer).toBeVisible();
 await composer.fill('What changed?');await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect.poll(()=>sent.length).toBe(1);
 expect(sent[0]).toMatchObject({addressAgentIds:['bea']});
});
