import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceRoute } from '../src/hooks/useWorkspaceRoute';
import { useThreadNavigation } from '../src/hooks/useThreadNavigation';
import { workspaceNavigationHref } from '../src/lib/workspaceScope';
import { parseAppPath } from '../src/lib/appRoute';
import type { RelayTaskListItem, RelaySession } from '../src/types';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('../src/lib/appRoute', async importOriginal => ({ ...await importOriginal<object>(), navigateToAppPath: navigate }));
const task = { id: 't', projectId: 'p', linkedSessionIds: [], isRoutine: false } as RelayTaskListItem;
const session = { id: 's', projectId: 'p' } as RelaySession;
const inputs = { tasks: [task], sessions: [session], agents: [], teams: [], nodes: [], ready: true };
beforeEach(() => { navigate.mockClear(); window.history.replaceState({}, '', '/home'); });

it.each([
  ['/tasks/t', '/projects/p?task=t'],
  ['/computers/c/tasks/t', '/projects/p?task=t'],
  ['/threads/s', '/projects/p/threads/s'],
  ['/computers/c/threads/s', '/projects/p/threads/s'],
])('moves %s into its owning workspace', async (path, destination) => {
  window.history.replaceState({}, '', path);
  const { result } = renderHook(() => useWorkspaceRoute({ ...inputs, location: parseAppPath(path) }));
  expect(result.current).toBe(true);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(destination, { replace: true }));
});

it('keeps a correctly scoped Project conversation open', () => {
  const { result } = renderHook(() => useWorkspaceRoute({ ...inputs, location: parseAppPath('/projects/p/threads/s') }));
  expect(result.current).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});

it('corrects a record opened under a different Project', () => {
  window.history.replaceState({}, '', '/projects/wrong?task=t');
  renderHook(() => useWorkspaceRoute({ ...inputs, location: parseAppPath(window.location.pathname) }));
  expect(navigate).toHaveBeenCalledWith('/projects/p?task=t', { replace: true });
});

it('corrects a standalone Task opened on the wrong Computer', () => {
  renderHook(() => useWorkspaceRoute({ ...inputs, tasks: [{ ...task, projectId: undefined, computerId: 'node:a' }], location: parseAppPath('/computers/node%3Ab/tasks/t') }));
  expect(navigate).toHaveBeenCalledWith('/computers/node%3Aa/tasks/t', { replace: true });
});

it('waits for data before canonicalizing a legacy record', () => {
  renderHook(() => useWorkspaceRoute({ ...inputs, ready: false, location: parseAppPath('/tasks/t') }));
  expect(navigate).not.toHaveBeenCalled();
});

it('starts a Project conversation without turning it into a global Task', () => {
  const syncThreadUrl = vi.fn();
  const { result } = renderHook(() => useThreadNavigation({
    route: 'projects', myThreads: [], tasks: [], tasksStatus: 'ready', activeSession: undefined,
    composingNew: false, routedSessionId: null, routedProjectId: 'p', recordTaskId: null,
    threadComputers: [], assignableComputers: [], composerRef: { current: null },
    pinTranscriptToBottom: vi.fn(), showThreadList: vi.fn(), syncThreadUrl, navigateToProject: vi.fn(),
  }));
  result.current.startNewThread('p');
  expect(syncThreadUrl).toHaveBeenCalledWith(null, false, 'p');
  expect(navigate).not.toHaveBeenCalled();
});

it('keeps old Project filters inside the Project', () => {
  window.history.replaceState({}, '', '/tasks?project=p');
  renderHook(() => useWorkspaceRoute({ ...inputs, location: parseAppPath('/tasks') }));
  expect(navigate).toHaveBeenCalledWith('/projects/p?tab=tasks', { replace: true });
});

it('moves an Automation run out of a mismatched Project', () => {
  window.history.replaceState({}, '', '/projects/wrong?tab=automations&automation=a&run=r');
  const occurrence = { ...task, id: 'r', sourceRoutineId: 'a' };
  renderHook(() => useWorkspaceRoute({ ...inputs, tasks: [occurrence], location: parseAppPath(window.location.pathname) }));
  expect(navigate).toHaveBeenCalledWith('/projects/p?tab=automations&automation=a&run=r', { replace: true });
});

it('keeps a run in its correct Automation workspace', () => {
  const occurrence = { ...task, id: 'r', projectId: undefined, computerId: 'c', sourceRoutineId: 'a' };
  const { result } = renderHook(() => useWorkspaceRoute({ ...inputs, tasks: [occurrence], location: parseAppPath('/computers/c/automations/a/runs/r') }));
  expect(result.current).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});


it('preserves an explicitly addressed older Thread while its detail loads', () => {
  const location = parseAppPath('/tasks/t/threads/older');
  const { result, rerender } = renderHook(({ sessions }) => useWorkspaceRoute({ ...inputs, sessions, location }), { initialProps: { sessions: [] as RelaySession[] } });
  expect(navigate).not.toHaveBeenCalled();
  expect(result.current).toBe(false);
  rerender({ sessions: [{ ...session, id: 'older' }] });
  expect(navigate).toHaveBeenCalledWith('/projects/p/threads/older', { replace: true });
});

it.each(['/tasks/missing', '/automations/missing', '/automations/missing/runs/missing-run'])(
  'provides a deliberate fallback for unresolved legacy record %s', path => {
    renderHook(() => useWorkspaceRoute({ ...inputs, location: parseAppPath(path) }));
    expect(navigate).toHaveBeenCalledWith('/computers', { replace: true });
  },
);


it.each([null, undefined])('keeps a Computer Thread open when the summary Project is %s', projectId => {
  const thread = { ...session, projectId, computerId: 'c' } as unknown as RelaySession;
  const { result } = renderHook(() => useWorkspaceRoute({ ...inputs, sessions: [thread], location: parseAppPath('/computers/c/threads/s') }));
  expect(result.current).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});

it.each([
  ['/tasks/t?tab=workspace', task, '/projects/p?task=t&recordTab=artifacts'],
  ['/tasks/t?tab=artifacts&priority=high', { ...task, projectId: undefined, computerId: 'c' }, '/computers/c/tasks/t?tab=artifacts&priority=high'],
  ['/automations/t?tab=artifacts', { ...task, isRoutine: true }, '/projects/p?tab=automations&automation=t&recordTab=artifacts'],
])('preserves the selected record tab while moving %s to its owning workspace', (url, record, expected) => {
  window.history.replaceState({}, '', url);
  renderHook(() => useWorkspaceRoute({ ...inputs, tasks: [record as RelayTaskListItem], location: parseAppPath(window.location.pathname) }));
  expect(navigate).toHaveBeenCalledWith(expected, { replace: true });
});

// Global navigation must work before a Computer workspace has been selected.
it.each(['/threads', '/automations', '/tasks'])('keeps the global list %s open', path => {
  const { result, rerender } = renderHook(({ ready }) => useWorkspaceRoute({ ...inputs, ready, location: parseAppPath(path) }), { initialProps: { ready: false } });
  expect(result.current).toBe(false);
  rerender({ ready: true });
  expect(result.current).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});

it.each([['main', '/threads'], ['routine', '/automations'], ['backlog', '/tasks']] as const)(
  'links the unscoped %s navigation to its list', (route, href) => {
    expect(workspaceNavigationHref(route, null, null)).toBe(href);
  },
);
it('retains the current workspace for scoped navigation', () => {
  expect(workspaceNavigationHref('routine', 'c', null)).toBe('/computers/c/automations');
  expect(workspaceNavigationHref('main', null, 'p')).toBe('/projects/p');
  expect(workspaceNavigationHref('routine', null, 'p')).toBe('/projects/p?tab=automations');
});
