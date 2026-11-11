"use client";
import { useTranslation } from 'react-i18next';
import { computerWorkHref } from '../lib/workspaceScope';
import { navigateToAppPath } from '../lib/appRoute';
import type { AppRoute } from '../lib/viewTypes';

export function ComputerWorkspaceNav({ computerId, label, route }: { computerId: string; label: string; route: AppRoute }) {
  const { t } = useTranslation();
  return <nav className="computer-workspace-nav" aria-label={label}>
    <a href="/computers" onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) { event.preventDefault(); void navigateToAppPath('/computers'); } }}>{label}</a>
    <div className="computer-workspace-tabs">
      {(['main', 'backlog', 'routine'] as const).map(section => <a key={section} href={computerWorkHref(computerId, section)} aria-current={route === section ? 'page' : undefined}
        onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) { event.preventDefault(); void navigateToAppPath(computerWorkHref(computerId, section)); } }}>
        {t(section === 'main' ? 'nav.threads' : section === 'backlog' ? 'nav.backlog' : 'nav.routine')}
      </a>)}
    </div>
  </nav>;
}
