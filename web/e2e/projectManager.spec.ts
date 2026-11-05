import {expect,test} from '@playwright/test';

for (const variant of [{mobile:false,zh:false},{mobile:true,zh:false},{mobile:true,zh:true}]) {
  const {mobile,zh}=variant;
  const labels=zh ? {ask:'询问 Relay',panel:'Relay 项目经理',next:'下一步任务',send:'发送',title:'标题',apply:'应用变更',applied:'已应用变更',back:'返回'} : {ask:'Ask Relay',panel:'Relay Project manager',next:'Next tasks',send:'Send',title:'Title',apply:'Apply changes',applied:'Changes applied',back:'Back'};
  test(`project manager asks, edits, applies and returns (${mobile ? 'mobile' : 'desktop'} ${zh ? 'Chinese dark' : 'English'})`, async ({page}) => {
    await page.setViewportSize(mobile ? {width:390,height:844} : {width:1440,height:900});
    const stamp='2026-11-06T00:00:00Z';
    const project={id:'launch',name:'Autumn launch',ownerUserId:'u',computerId:'computer',enabled:true,members:[],leadAgentId:null,version:1,workspaceLayout:'project',workspaceSubpath:'projects/launch',createdAt:stamp,updatedAt:stamp};
    let threadId: string | null=null;
    let sent=0;
    const applications: unknown[]=[];
    const tasks: Array<Record<string,unknown>>=[];
    const proposal={id:'proposal',projectId:'launch',threadId:'manager-thread',agentId:'ada',runId:'run',state:'pending',revision:1,createdAt:stamp,
      operations:[{id:'0',kind:'create',key:'design',fields:{title:'Design login',description:'List the accepted login states.',priority:'high'},after:[],afterTaskIds:[]}]};
    await page.route('**/api/**', async route => {
      const path=new URL(route.request().url()).pathname;
      const method=route.request().method();
      let body: unknown={sessions:[],agents:[],teams:[],nodes:[],projects:[project],tasks,sandboxes:[],skills:[]};
      if(path.endsWith('/auth/me')) body={authenticated:true,user:{id:'u',userId:'u',username:'Fei',role:'user',theme:zh ? 'dark' : 'light',language:zh ? 'zh-CN' : 'en'}};
      if(path.endsWith('/manager')) body={project,manager:{agentId:'ada',agentName:'Ada',threadId,toolsAvailable:true,reason:null,candidates:[{id:'ada',displayName:'Ada'}]},proposals:threadId ? [proposal] : []};
      if(path.endsWith('/manager/messages') && method==='POST') {sent++; threadId='manager-thread';body={threadId};}
      if(path.endsWith('/threads/manager-thread')) body={id:threadId,taskGoal:'Relay · Autumn launch',projectId:'launch',ownerUserId:'u',participants:['human'],status:'completed',phase:'done',events:[],agentRuns:[],artifacts:[],messages:[],createdAt:stamp,updatedAt:stamp,execution:{phase:'terminal',executionConfirmed:true,deletionRequested:false,canDelete:true,blockingReason:null,lastConfirmedAt:stamp,nextRecoveryAt:null}};
      if(path.endsWith('/proposal/apply')) {
        const input=route.request().postDataJSON();applications.push(input);
        tasks.push({id:'created-task',title:input.fields['0'].title,projectId:'launch',status:'backlog',priority:'high',isRoutine:false,ownerUserId:'u',linkedSessionIds:[],createdAt:stamp,updatedAt:stamp});
        proposal.state='applied';proposal.revision=2;body={proposal,tasks};
      }
      if(path.endsWith('/events')) body={events:[]};
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto('/projects/launch');
    await page.getByRole('button',{name:labels.ask,exact:true}).click();
    const panel=page.getByRole('complementary',{name:labels.panel,exact:true});
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/manager=open/);
    if(!mobile) {
      const before=await panel.boundingBox();
      const resize=panel.getByRole('separator',{name:'Resize project manager'});
      await resize.focus();await page.keyboard.press('ArrowLeft');
      await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before!.width);
    }
    expect(sent).toBe(0);
    await panel.getByRole('button',{name:labels.next,exact:true}).click();
    await expect(panel.getByRole('textbox',{name:labels.ask,exact:true})).toHaveValue(zh ? /下一步/ : /next/);
    await panel.getByRole('textbox',{name:labels.ask,exact:true}).fill('Plan the login work.');
    await panel.getByRole('button',{name:labels.send,exact:true}).click();
    await expect(panel.getByRole('textbox',{name:labels.title,exact:true})).toHaveValue('Design login');
    await page.reload();
    await expect(panel.getByRole('textbox',{name:labels.title,exact:true})).toHaveValue('Design login');
    await panel.getByRole('textbox',{name:labels.title,exact:true}).fill('Design sign in');
    await page.screenshot({path:`../output/playwright/project-manager-${mobile ? 'mobile' : 'desktop'}-${zh ? 'zh-dark' : 'en'}.png`,fullPage:true});
    const bounds=await panel.boundingBox();
    expect(bounds).toBeTruthy();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.width).toBeLessThanOrEqual(mobile ? 390 : 1440);
    await panel.getByRole('button',{name:labels.apply,exact:true}).click();
    await expect(panel.getByText(labels.applied,{exact:true})).toBeVisible();
    expect(applications).toHaveLength(1);expect(tasks[0].status).toBe('backlog');expect(tasks[0].title).toBe('Design sign in');
    await panel.getByRole('button',{name:labels.back,exact:true}).click();
    await expect(panel).not.toBeVisible();await expect(page).not.toHaveURL(/manager=open/);
  });
}
