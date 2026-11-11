"use client";
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRelayMutations } from '../hooks/useRelayMutations';
import type { RelayTaskListItem } from '../types';
import { Button } from '@/components/ui/button';

/** Old intake and Automations have no saved Computer; placement is explicit. */
export function UnplacedComputerWork({ computerId, tasks }: { computerId: string; tasks: RelayTaskListItem[] }) {
  const { t } = useTranslation();
  const { updateTaskMutation } = useRelayMutations();
  const [pending, setPending] = useState<string | null>(null);
  if (!tasks.length) return null;
  return <details className="computer-unplaced-work">
    <summary>{t('computer.unplaced_work', { count: tasks.length })}</summary>
    <ul>{tasks.map(task => <li key={task.id}>
      <span>{task.title}</span>
      <Button variant="outline" size="sm" disabled={pending !== null} onClick={async () => {
        setPending(task.id);
        try { await updateTaskMutation.mutateAsync({ taskId: task.id, input: { computerId } }); }
        catch { /* The mutation reports the error and preserves this placement choice. */ }
        finally { setPending(null); }
      }}>{t('computer.place_work_here')}</Button>
    </li>)}</ul>
  </details>;
}
