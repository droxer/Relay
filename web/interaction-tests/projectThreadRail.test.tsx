import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { threadDirectoryMode } from '../src/lib/threads';
import { parseAppPath } from '../src/lib/appRoute';
import { ThreadListPanel } from '../src/components/ThreadListPanel';
import type { ProjectRecord, RelaySession } from '../src/types';

const project = { id: 'p', name: 'Harness Research', members: [], enabled: true } as unknown as ProjectRecord;
const sessions = ['Conversation', 'Task run', 'Automation run'].map((title, index) => ({
  id: `s${index}`, projectId: 'p', title, taskGoal: title, status: 'completed',
  updatedAt: '2026-11-11T00:00:00Z', agentRuns: [],
}) as unknown as RelaySession);

function panel(path: string, selectedSessionId: string | undefined = 's1') {
  const location = parseAppPath(path);
  return <ThreadListPanel directoryMode={threadDirectoryMode(location.route, location.sessionId, location.composingNew)} threads={sessions.map(session => ({ session }))}
    tasks={[]} projects={[project]} projectsStatus="ready" projectsError="" onRetryProjects={vi.fn()}
    query="" setQuery={vi.fn()} projectFilter="all" projectFilterOptions={[]} onProjectFilterChange={vi.fn()} kindFilter="all" onKindFilterChange={vi.fn()}
    selectedSessionId={selectedSessionId} selectedProjectId={location.projectId ?? null} listOnScreen={false}
    onSelectThread={vi.fn()} onSelectProject={vi.fn()} onCreateProject={vi.fn()} onNewThread={vi.fn()}
    onRenameThread={vi.fn()} onCloseThread={vi.fn()} width={300} onResize={vi.fn()} onResizeActive={vi.fn()} />;
}

it('shows the Thread list beside an open Project thread instead of Project folders', () => {
  render(panel('/projects/p/threads/s1'));
  const rail = screen.getByRole('complementary', { name: 'nav.threads' });
  expect(within(rail).getByRole('heading', { name: 'nav.threads' })).toBeTruthy();
  for (const session of sessions) expect(within(rail).getByText(session.title!)).toBeTruthy();
  expect(rail.querySelector('.project-folder')).toBeNull();
  expect(rail.querySelector('.conversation-group[data-tone="idle"] .conversation-group-label')).toBeNull();
});

it('keeps the Project directory when no Thread is open', () => {
  render(panel('/projects/p', undefined));
  const rail = screen.getByRole('complementary', { name: 'project.projects' });
  expect(within(rail).getByText(project.name)).toBeTruthy();
  expect(within(rail).queryByText('Task run')).toBeNull();
});

it('restores Project folders after leaving a Thread for the Projects root', () => {
  const view = render(panel('/projects/p/threads/s1'));
  view.rerender(panel('/projects'));
  const rail = screen.getByRole('complementary', { name: 'project.projects' });
  expect(within(rail).getByText(project.name)).toBeTruthy();
  expect(within(rail).queryByText('Task run')).toBeNull();
});

it('keeps project conversation creation in the Threads list', () => {
  render(panel('/projects/p/new', undefined));
  const rail = screen.getByRole('complementary', { name: 'nav.threads' });
  expect(within(rail).getByRole('button', { name: 'thread.new_thread' })).toBeTruthy();
  expect(rail.querySelector('.project-folder')).toBeNull();
});

it('offers the task/chat switch on the Threads rail only', () => {
  const view = render(panel('/projects/p/threads/s1'));
  const group = screen.getByRole('group', { name: 'thread.kind_filter_label' });
  expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
    'thread.kind_filter_all', 'thread.kind_filter_tasks', 'thread.kind_filter_chats',
  ]);
  expect(within(group).getByRole('button', { name: 'thread.kind_filter_all' }).getAttribute('aria-pressed')).toBe('true');
  view.rerender(panel('/projects', undefined));
  expect(screen.queryByRole('group', { name: 'thread.kind_filter_label' })).toBeNull();
});
