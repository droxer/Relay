import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { connectionResources, getConnectionGrants, listConnections,
  type ConnectionGrant, type ConnectionTarget, type ServiceConnection } from "../../api-client/connections";

interface Props {
  value?: ConnectionGrant[];
  targetType?: ConnectionTarget;
  targetId?: string;
  disabled?: boolean;
  onChange: (grants: ConnectionGrant[]) => void;
}

export function ConnectionGrantField(props: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return <details className="connection-grants" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t("connections.title")} <span className="connections-hint">{props.value?.length
      ? t("connections.selected", { count: props.value.length })
      : t(props.targetId && props.value === undefined ? "connections.review_access" : "connections.none_selected")}</span></summary>
    {expanded && <ConnectionGrantContent {...props} />}
  </details>;
}

function ConnectionGrantContent({ value, targetType = "thread", targetId, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const connections = useQuery({ queryKey: ["connections", "list"], queryFn: listConnections });
  const saved = useQuery({ queryKey: ["connections", "grants", targetType, targetId],
    queryFn: () => getConnectionGrants(targetType, targetId!), enabled: Boolean(targetId) });
  const selected = value ?? saved.data?.grants ?? [];
  const readonly = disabled || saved.data?.readOnly || (saved.data?.targetType === "task" && targetType === "thread");
  const records = connections.data?.connections ?? [];
  const update = (connectionId: string, patch: Partial<ConnectionGrant> | null) => {
    const others = selected.filter(grant => grant.connectionId !== connectionId);
    const prior = selected.find(grant => grant.connectionId === connectionId);
    onChange(patch ? [...others, { connectionId, resources: [], actions: [], ...prior, ...patch }] : others);
  };
  return <div className="connection-grants-body">
      <p className="connections-hint">{t("connections.grant_hint")}</p>
      {saved.data?.readOnly && <p>{t("connections.inherited")}</p>}
      {saved.data?.targetType === "task" && targetType === "thread" && <p>{t("connections.task_managed")}</p>}
      {(connections.isPending || (targetId && saved.isPending)) && <p role="status">{t("connections.loading")}</p>}
      {(connections.error || saved.error) && <p role="alert">{t("connections.load_failed")}</p>}
      {selected.filter(grant => !records.some(c => c.id === grant.connectionId)).map(grant => <p key={grant.connectionId} role="alert">{t("connections.missing")}
        <Button type="button" variant="ghost" disabled={readonly} onClick={() => update(grant.connectionId, null)}>{t("connections.remove")}</Button>
      </p>)}
      {records.map(connection => {
        const grant = selected.find(item => item.connectionId === connection.id);
        return <div className="connection-grant" key={connection.id}>
          <label className="connection-choice"><Checkbox checked={Boolean(grant)} disabled={readonly || connection.status !== "connected"}
            onCheckedChange={checked => update(connection.id, checked ? { actions: connection.actions.filter(action => action !== "slack.post_message") } : null)} />
            <span>{connection.label} · {connection.identity}</span>
          </label>
          {connection.status !== "connected" && <p role="alert">{t("connections.status.reconnect_required")}</p>}
          {grant && <GrantOptions connection={connection} grant={grant} disabled={Boolean(readonly)}
            onChange={patch => update(connection.id, patch)} expanded />}
        </div>;
      })}
      <a href="/settings/connections" target="_blank" rel="noopener noreferrer">{t("connections.connect_new_tab")}</a>
  </div>;
}

function GrantOptions({ connection, grant, onChange, disabled, expanded }: {
  connection: ServiceConnection; grant: ConnectionGrant; onChange: (patch: Partial<ConnectionGrant>) => void; disabled: boolean; expanded: boolean;
}) {
  const { t } = useTranslation();
  const resources = useInfiniteQuery({ queryKey: ["connections", "resources", connection.id],
    queryFn: ({ pageParam }) => connectionResources(connection.id, pageParam), initialPageParam: "",
    getNextPageParam: page => page.nextCursor ?? undefined, enabled: expanded && connection.status === "connected" });
  const items = [...new Map((resources.data?.pages.flatMap(page => page.resources) ?? []).map(r => [r.id, r])).values()];
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(v => v !== id) : [...values, id];
  return <div className="connection-grant-options">
    <fieldset disabled={disabled}><legend>{t("connections.resources")}</legend>
      {resources.isPending && <p role="status">{t("connections.loading")}</p>}
      {resources.error && <p role="alert">{t("connections.resources_failed")} <Button type="button" variant="outline" onClick={() => void resources.refetch()}>{t("connections.retry")}</Button></p>}
      {!resources.isPending && !resources.error && !items.length && <p>{t("connections.no_resources")}</p>}
      {grant.resources.filter(id => !items.some(item => item.id === id)).map(id => <label className="connection-choice" key={id}>
        <Checkbox checked onCheckedChange={() => onChange({ resources: toggle(grant.resources, id) })} />{id}
      </label>)}
      {items.map(item => <label className="connection-choice" key={item.id}><Checkbox checked={grant.resources.includes(item.id)}
        onCheckedChange={() => onChange({ resources: toggle(grant.resources, item.id) })} />{item.name}</label>)}
      {resources.hasNextPage && <Button type="button" variant="ghost" disabled={resources.isFetchingNextPage} onClick={() => void resources.fetchNextPage()}>{t("connections.load_more")}</Button>}
    </fieldset>
    <fieldset disabled={disabled}><legend>{t("connections.actions")}</legend>
      {connection.actions.map(action => <label className="connection-choice" key={action}><Checkbox checked={grant.actions.includes(action)}
        onCheckedChange={() => onChange({ actions: toggle(grant.actions, action) })} />{t(`connections.action.${action.replaceAll(".", "_")}`)}</label>)}
    </fieldset>
    {grant.actions.includes("slack.post_message") && <p>{t("connections.write_notice")}</p>}
    {(!grant.resources.length || !grant.actions.length) && <p role="alert">{t("connections.selection_required")}</p>}
  </div>;
}
