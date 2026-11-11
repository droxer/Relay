import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SideNav } from '../src/components/SideNav';
import { useAppRouter } from '../src/hooks/useAppRouter';

const destinations = [
  ['nav.home', '/home'], ['nav.threads', '/threads'], ['nav.backlog', '/tasks'],
  ['nav.routine', '/automations'], ['project.projects', '/projects'],
  ['nav.agents', '/agents'], ['nav.teams', '/teams'], ['nav.computers', '/computers'],
  ['nav.skills', '/skills'], ['nav.settings', '/settings/notifications'],
  ['nav.admin', '/admin/dashboard'],
] as const;

const applySession = vi.fn();

function Navigation() {
  const [composingNew, setComposingNew] = useState(false);
  const router = useAppRouter({ composingNew, activeSessionId: 's', selectedSessionId: 's', activeSession: undefined,
    onApplySessionFromPath: applySession, onSetComposingNewFromPath: setComposingNew });
  return <SideNav sidenavExpanded={false} setSidenavExpanded={vi.fn()} width={200}
    onResize={vi.fn()} onResizeActive={vi.fn()} route={router.route}
    threadOpen={Boolean(router.routedSessionId) || composingNew}
    onNavigateRoute={router.navigateToRoute} hrefForRoute={router.hrefForSideNavRoute}
    isAdmin={true} onLogout={vi.fn()} onOpenCommandMenu={vi.fn()} />;
}

it.each(destinations)('navigates from a Project thread using %s to %s', async (name, path) => {
  window.history.replaceState({}, '', '/projects/p/threads/s');
  render(<Navigation />);
  expect(screen.getByRole('link', { name: 'nav.threads' }).getAttribute('aria-current')).toBe('page');
  const link = screen.getByRole('link', { name });
  expect(link.getAttribute('href')).toBe(path);
  fireEvent.click(link);
  await waitFor(() => expect(window.location.pathname).toBe(path));
  expect(link.getAttribute('aria-current')).toBe('page');
});

it('selects Threads for a new Project conversation and Projects after following its sidebar link', async () => {
  window.history.replaceState({}, '', '/projects/p/new');
  render(<Navigation />);
  expect(screen.getByRole('link', { name: 'nav.threads' }).getAttribute('aria-current')).toBe('page');
  const projects = screen.getByRole('link', { name: 'project.projects' });
  fireEvent.click(projects);
  await waitFor(() => expect(window.location.pathname).toBe('/projects'));
  expect(projects.getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: 'nav.threads' }).getAttribute('aria-current')).toBeNull();
});

it('restores sidebar selection with browser Back and Forward', async () => {
  window.history.replaceState({}, '', '/projects/p/threads/s');
  render(<Navigation />);
  fireEvent.click(screen.getByRole('link', { name: 'project.projects' }));
  await waitFor(() => expect(window.location.pathname).toBe('/projects'));
  window.history.back();
  await waitFor(() => expect(window.location.pathname).toBe('/projects/p/threads/s'));
  expect(screen.getByRole('link', { name: 'nav.threads' }).getAttribute('aria-current')).toBe('page');
  window.history.forward();
  await waitFor(() => expect(window.location.pathname).toBe('/projects'));
  expect(screen.getByRole('link', { name: 'project.projects' }).getAttribute('aria-current')).toBe('page');
});
