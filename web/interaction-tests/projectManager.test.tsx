import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProjectManagerPanel } from '../src/components/ProjectManagerPanel';
import { ManagerProposalCard } from '../src/components/ManagerProposalCard';

const api = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), apply: vi.fn(), dismiss: vi.fn(), set: vi.fn() }));
vi.mock('react-i18next', async () => {
  const {default: en} = await import('../src/i18n/locales/en/translation.json');
  return {useTranslation: () => ({t: (key: string, values: Record<string,string> = {}) => {
    const label = key.startsWith('project_manager.') ? en.project_manager[key.slice(16) as keyof typeof en.project_manager] : key;
    return Object.entries(values).reduce((text,[name,value]) => text.replaceAll(`{{${name}}}`,value), label || key);
  }, i18n:{language:'en'}})};
});
vi.mock('../src/api-client/project-manager', () => ({
  getProjectManager: api.get, sendManagerMessage: api.send, applyManagerProposal: api.apply,
  dismissManagerProposal: api.dismiss, setProjectManager: api.set,
}));
vi.mock('../src/components/MessageBlock', () => ({ MessageBlock: () => null }));
const proposal = {
  id: 'proposal', projectId: 'p', threadId: 'thread', agentId: 'a', runId: 'run', state: 'pending' as const,
  revision: 1, createdAt: '2026-11-06T00:00:00Z', operations: [
    {id: '0', kind: 'create' as const, key: 'design', fields: {title: 'Design login'}, after: [], afterTaskIds: []},
    {id: '1', kind: 'update' as const, taskId: 'task', title: 'Build login', fields: {priority: 'high'}, before: {priority: 'normal'}, after: [], afterTaskIds: []},
  ],
};
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}>{ui}</QueryClientProvider>);
beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({project: {id:'p',version:1}, manager:{agentId:'a',agentName:'Ada',threadId:null,reason:null,toolsAvailable:true,candidates:[{id:'a',displayName:'Ada'}]}, proposals:[]});
  api.send.mockResolvedValue({threadId:'thread'});
  api.apply.mockResolvedValue({proposal:{...proposal,state:'applied'},tasks:[]});
});

it('opens without dispatching and turns a suggested prompt into editable input', async () => {
  wrap(<ProjectManagerPanel projectId="p" projectName="Launch" onClose={vi.fn()} onOpenThread={vi.fn()} />);
  await screen.findByRole('option', {name:'Ada'});
  expect(api.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name:'Next tasks'}));
  const input = screen.getByRole('textbox', {name:'Ask Relay'});
  expect((input as HTMLTextAreaElement).value).toContain('next');
  fireEvent.change(input, {target:{value:'What is blocked?'}});
  fireEvent.click(screen.getByRole('button', {name:'Send'}));
  await waitFor(() => expect(api.send).toHaveBeenCalledWith('p', expect.objectContaining({text:'What is blocked?',idempotencyKey:expect.any(String)})));
});

it('allows editing and selecting proposal items before applying the exact batch', async () => {
  wrap(<ManagerProposalCard projectId="p" proposal={proposal} disabled={false} onChanged={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', {name:'Title'}), {target:{value:'Design sign in'}});
  fireEvent.click(screen.getByRole('checkbox', {name:/Build login/}));
  fireEvent.click(screen.getByRole('button', {name:'Apply changes'}));
  await waitFor(() => expect(api.apply).toHaveBeenCalledWith('p','proposal',expect.objectContaining({operationIds:['0'],fields:{'0':{title:'Design sign in'}},expectedRevision:1,idempotencyKey:expect.any(String)})));
});

it('keeps a failed apply visible and retry uses the same idempotency key', async () => {
  api.apply.mockRejectedValue(new Error('Task changed; refresh the proposal.'));
  wrap(<ManagerProposalCard projectId="p" proposal={proposal} disabled={false} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', {name:'Apply changes'}));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', {name:'Apply changes'}));
  await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(2));
  expect(api.apply.mock.calls[0][2].idempotencyKey).toBe(api.apply.mock.calls[1][2].idempotencyKey);
});
