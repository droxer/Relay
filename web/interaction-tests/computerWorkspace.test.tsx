import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ComputerWorkspaceNav } from '../src/components/ComputerWorkspaceNav';
import { UnplacedComputerWork } from '../src/components/UnplacedComputerWork';
import { useBacklogTaskForm } from '../src/hooks/useBacklogTaskForm';
import { emptyBacklogForm } from '../src/lib/taskBoardForm';
import type { CurrentUser, RelayTaskListItem } from '../src/types';

const { create, update } = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock('../src/hooks/useRelayMutations', () => ({ useRelayMutations: () => ({
  createTaskMutation: { mutateAsync: create }, updateTaskMutation: { mutateAsync: update }, deleteTaskMutation: {},
}) }));
vi.mock('../src/components/ui/DialogProvider', () => ({ useDialogs: () => ({ announce: vi.fn(), confirm: vi.fn() }) }));
vi.mock('../src/hooks/useUnsavedChangesGuard', () => ({ useUnsavedChangesGuard: () => vi.fn(async () => true) }));
const user = { userId: 'u', username: 'u' } as CurrentUser;

it('shows only the Computer name above the Thread list', () => {
  render(<ComputerWorkspaceNav computerId="device:u:host" label="My Computer" route="main" />);
  expect(screen.getByRole('link', { name: 'My Computer' }).getAttribute('href')).toBe('/computers');
  expect(screen.queryByRole('link', { name: 'nav.backlog' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'nav.routine' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'nav.threads' })).toBeNull();
});

it('keeps every Computer tab under the same stable identity', () => {
  render(<ComputerWorkspaceNav computerId="device:u:host" label="My Computer" route="backlog" />);
  expect(screen.getByRole('link', { name: 'nav.threads' }).getAttribute('href')).toBe('/computers/device%3Au%3Ahost/threads');
  expect(screen.getByRole('link', { name: 'nav.backlog' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: 'nav.routine' }).getAttribute('href')).toBe('/computers/device%3Au%3Ahost/automations');
});

it('saves a new standalone Task in the selected Computer workspace', async () => {
  create.mockResolvedValueOnce({ id: 't' });
  const { result } = renderHook(() => useBacklogTaskForm({ currentUser: user, seed: { computerId: 'device:u:host' } }));
  act(() => result.current.openForm({ ...emptyBacklogForm(user), title: 'Local work' }));
  await act(async () => result.current.submit({ preventDefault: vi.fn() } as never));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Local work', computerId: 'device:u:host' }));
  expect(create.mock.lastCall?.[0].projectId).toBeUndefined();
  expect(result.current.open).toBe(false);
});

it('requires an explicit action before placing legacy work on a Computer', async () => {
  update.mockResolvedValueOnce({ id: 'old' });
  render(<UnplacedComputerWork computerId="device:u:host" tasks={[{ id: 'old', title: 'Legacy work' } as RelayTaskListItem]} />);
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('computer.unplaced_work'));
  fireEvent.click(screen.getByRole('button', { name: 'computer.place_work_here' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ taskId: 'old', input: { computerId: 'device:u:host' } }));
});

it('never returns a record to another Computer workspace', async () => {
  const { rememberListUrl, recordBackHref } = await import('../src/lib/recordBack');
  window.history.replaceState({}, '', '/computers/a/tasks?q=local');
  rememberListUrl();
  expect(recordBackHref('/computers/a/tasks')).toBe('/computers/a/tasks?q=local');
  expect(recordBackHref('/computers/b/tasks')).toBe('/computers/b/tasks');
});

it('offers only Agents on the standalone Task Computer', async () => {
  const { taskAssignmentOptions } = await import('../src/lib/taskAssignment');
  const agents = ['a', 'b'].map(id => ({ id, supervisorUserId: 'u', placements: [{ computerId: id, desiredState: 'active' }] })) as never;
  const options = taskAssignmentOptions({ computerId: 'a', agents, teams: [], assigneeUserId: 'u' });
  expect(options.agents.map(agent => agent.id)).toEqual(['a']);
});
