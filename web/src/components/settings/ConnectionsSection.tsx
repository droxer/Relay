import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { listConnections, listConnectionProviders, startConnection, disconnectConnection, connectionUsage } from "../../api-client/connections";

export function ConnectionsSection() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [removing, setRemoving] = useState<string | null>(null);
  const connections = useQuery({ queryKey: ["connections", "list"], queryFn: listConnections });
  const providers = useQuery({ queryKey: ["connections", "providers"], queryFn: listConnectionProviders });
  const usage = useQuery({ queryKey: ["connections", "usage", removing], queryFn: () => connectionUsage(removing!), enabled: Boolean(removing) });
  const authorize = useMutation({ mutationFn: ({ provider, id }: { provider: string; id?: string }) => startConnection(provider, id),
    onSuccess: ({ url }) => window.location.assign(url) });
  const disconnect = useMutation({ mutationFn: disconnectConnection, onSuccess: async () => {
    setRemoving(null);
    await client.invalidateQueries({ queryKey: ["connections"] });
    await client.invalidateQueries({ queryKey: ["tasks"] });
  } });
  if (connections.isPending || providers.isPending) return <p role="status">{t("connections.loading")}</p>;
  if (connections.error || providers.error) return <div role="alert">{t("connections.load_failed")} <Button variant="outline" onClick={() => {
    void connections.refetch(); void providers.refetch();
  }}>{t("connections.retry")}</Button></div>;
  const records = connections.data?.connections ?? [];
  return <div className="connections-section">
    <p className="connections-hint">{t("connections.intro")}</p>
    {(authorize.error || disconnect.error) && <p role="alert">{t("connections.action_failed")}</p>}
    <section aria-labelledby="your-connections">
      <h3 id="your-connections" className="pref-group-label">{t("connections.yours")}</h3>
      {!records.length && <p className="connections-hint">{t("connections.empty")}</p>}
      {records.map(connection => <div className="connection-row" key={connection.id}>
        <div className="connection-identity">
          <span className="pref-option-label">{providers.data?.providers.find(p => p.id === connection.provider)?.name} · {connection.label}</span>
          <span className="pref-option-sub">{connection.identity}</span>
          <Badge variant={connection.status === "connected" ? "neutral" : "warning"}>{t(`connections.status.${connection.status}`)}</Badge>
        </div>
        <div className="connection-actions">
          {connection.status !== "connected" && <Button type="button" variant="outline" disabled={authorize.isPending}
            onClick={() => authorize.mutate({ provider: connection.provider, id: connection.id })}>{t("connections.reconnect")}</Button>}
          <Button type="button" variant="ghost" onClick={() => setRemoving(connection.id)}>{t("connections.disconnect")}</Button>
        </div>
        {removing === connection.id && <div className="connection-impact" role="group" aria-label={t("connections.disconnect")}>
          <p>{t("connections.disconnect_body", { identity: connection.label })}</p>
          {usage.isPending ? <p role="status">{t("connections.loading")}</p> : usage.error
            ? <p role="alert">{t("connections.usage_failed")}</p>
            : <p>{t("connections.used_by", { count: usage.data?.usage.length ?? 0 })}</p>}
          <ul>{usage.data?.usage.map(item => <li key={`${item.targetType}:${item.targetId}`}>
            <a href={item.targetType === "thread" ? `/threads/${item.targetId}` : `/${item.targetType === "automation" ? "automations" : "tasks"}/${item.targetId}`}>
              {t(`connections.targets.${item.targetType}`)} · {item.targetId}
            </a>
          </li>)}</ul>
          <div className="connection-actions">
            <Button type="button" variant="destructive" disabled={disconnect.isPending} onClick={() => disconnect.mutate(connection.id)}>{t("connections.confirm_disconnect")}</Button>
            <Button type="button" variant="outline" onClick={() => setRemoving(null)}>{t("connections.cancel")}</Button>
          </div>
        </div>}
      </div>)}
    </section>
    <section aria-labelledby="available-connections">
      <h3 id="available-connections" className="pref-group-label">{t("connections.available")}</h3>
      {providers.data?.providers.map(provider => <div className="connection-row" key={provider.id}>
        <div className="connection-identity"><span className="pref-option-label">{provider.name}</span>
          <span className="pref-option-sub">{t(provider.configured ? `connections.provider_hint.${provider.id}` : "connections.not_configured")}</span>
        </div>
        {provider.configured && <Button type="button" variant="outline" disabled={authorize.isPending}
          aria-label={`${t("connections.connect")} ${provider.name}`}
          onClick={() => authorize.mutate({ provider: provider.id })}>{t(records.some(c => c.provider === provider.id) ? "connections.add_another" : "connections.connect")}</Button>}
      </div>)}
    </section>
  </div>;
}
