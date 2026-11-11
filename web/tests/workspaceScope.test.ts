import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppPath, pathForAppState, canonicalBrowserUrl } from '../src/lib/appRoute.ts';
import { threadsForDirectory } from '../src/lib/threads.ts';

test('Computer workspace routes retain their Computer and records', () => {
  for (const [section, route] of [['threads', 'main'], ['tasks', 'backlog'], ['automations', 'routine']] as const) {
    const path = `/computers/device%3Au%3Am/${section}`;
    const state = parseAppPath(path);
    assert.equal(state.route, route);
    assert.equal(state.computerId, 'device:u:m');
    assert.equal(pathForAppState(state), path);
  }
  const path = '/computers/device%3Au%3Am/threads/s1';
  assert.equal(parseAppPath(path).sessionId, 's1');
  assert.equal(pathForAppState(parseAppPath(path)), path);
  assert.equal(canonicalBrowserUrl('/computers/c/tasks/t1', '?tab=artifacts'), '/computers/c/tasks/t1?tab=artifacts');
  assert.equal(canonicalBrowserUrl('/computers/c/threads/s1', '?space=1'), '/computers/c/threads/s1?space=1');
  assert.equal(parseAppPath('/computers/c/automations/a/runs/r').runId, 'r');
});

test('Threads outside Projects never include Project tasks or manager conversations', () => {
  const projects = [{ id: 'p', managerThreadId: 'manager' }] as any;
  const threads = [
    { session: { id: 'standalone' } },
    { session: { id: 'task', projectId: 'p' }, origin: { kind: 'task' } },
    { session: { id: 'manager', projectId: 'p' } },
    { session: { id: 'missing-project', projectId: 'gone' } },
  ] as any;
  assert.deepEqual(threadsForDirectory(threads, projects, 'threads').map(t => t.session.id), ['standalone']);
});

test('standalone records use their recorded Computer and Automation runs use their parent', async () => {
  const { sessionComputer, taskComputer, taskWorkspaceHref, recordHrefForLocation } = await import('../src/lib/workspaceScope.ts');
  const nodes = [{ id: 'a', userId: 'u', workspaceId: 'machine' }];
  assert.equal(sessionComputer({ daemonNodeId: 'a' }, nodes), 'device:u:machine');
  assert.equal(sessionComputer({ computerId: 'stable', daemonNodeId: 'a' }, nodes), 'stable');
  assert.equal(sessionComputer({}, nodes), null);
  const base: import('../src/types.ts').RelayTaskListItem = { id: 't', title: 'Work', description: '', priority: 'normal', status: 'backlog', isRoutine: false, linkedSessionIds: [], createdAt: '2026-11-11', updatedAt: '2026-11-11' };
  assert.equal(taskComputer({ ...base, computerId: 'stable' }, nodes), 'stable');
  assert.equal(taskComputer({ ...base, projectId: 'p', computerId: 'stable' }, nodes), null);
  assert.equal(taskComputer(base, nodes), null);
  assert.equal(recordHrefForLocation('backlog', 't', null, '/projects/p'), '/projects/p?task=t');
  assert.equal(recordHrefForLocation('routine', 'auto', 'run', '/computers/c/automations'), '/computers/c/automations/auto/runs/run');
  const occurrence = { ...base, id: 'run', sourceRoutineId: 'auto' };
  assert.equal(taskWorkspaceHref(occurrence, 'c'), '/computers/c/automations/auto/runs/run');
  assert.equal(taskWorkspaceHref({ ...occurrence, projectId: 'p' }, null), '/projects/p?tab=automations&automation=auto&run=run');
});

test('legacy records recover only recorded execution, and record links preserve their workspace', async () => {
  const { sessionComputer, taskComputer, taskWorkspaceHref, computerWorkHref, recordHrefForLocation } = await import('../src/lib/workspaceScope.ts');
  const nodes = [{ id: 'n', userId: 'u', workspaceId: 'm' }];
  const base: import('../src/types.ts').RelayTaskListItem = { id: 't', title: 'Work', description: '', priority: 'normal', status: 'backlog', isRoutine: false, linkedSessionIds: ['missing', 'unbound', 's'], createdAt: '2026-11-11', updatedAt: '2026-11-11' };
  const sessions = [{ id: 's', daemonNodeId: 'n' }, { id: 'unbound' }] as import('../src/types.ts').RelaySession[];
  assert.equal(sessionComputer({ daemonNodeId: 'retired' }, nodes), 'node:retired');
  assert.equal(taskComputer(base, nodes, sessions), 'device:u:m');
  assert.equal(taskComputer({ ...base, linkedSessionIds: ['missing', 'unbound'] }, nodes, sessions), null);
  assert.equal(taskComputer({ ...base, workspaceBinding: { computerId: 'old', layout: 'task' } }, nodes), 'old');
  assert.equal(taskWorkspaceHref({ ...base, projectId: 'p' }, null), '/projects/p?task=t');
  assert.equal(taskWorkspaceHref({ ...base, isRoutine: true }, 'c', 'run'), '/computers/c/automations/t/runs/run');
  assert.equal(taskWorkspaceHref({ ...base, isRoutine: true, projectId: 'p' }, null), '/projects/p?tab=automations&automation=t');
  assert.equal(taskWorkspaceHref(base, null), null);
  assert.equal(computerWorkHref('c'), '/computers/c/threads');
  assert.equal(recordHrefForLocation('routine', 'a', 'r', '/projects/p'), '/projects/p?tab=automations&automation=a&run=r');
  assert.equal(recordHrefForLocation('backlog', null, null, '/projects/p'), '/projects/p?tab=tasks');
  assert.equal(recordHrefForLocation('backlog', 't', null, '/tasks'), '/tasks/t');
  assert.equal(recordHrefForLocation('backlog', 't'), '/tasks/t');
});
