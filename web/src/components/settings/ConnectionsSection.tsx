import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GithubMark } from "../landing/GithubMark";
import { AdminInbox, ICON } from "../icons";
import { mailProviderName, readConnectionResult } from "../../domain-types/connections";
import { TASKS_QUERY_KEY } from "../../hooks/useRelayData";
import { TASK_RECORD_QUERY_KEY } from "../../hooks/useTaskRecord";
import { listConnections, listConnectionProviders, startConnection, disconnectConnection, connectionUsage } from "../../api-client/connections";

export function ConnectionsSection() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [removing, setRemoving] = useState<string | null>(null);
  const [consent, setConsent] = useState<{ provider: string; id?: string } | null>(null);
  const [outcome] = useState(() => typeof window === "undefined" ? null
    : readConnectionResult(new URLSearchParams(window.location.search)));
  const connections = useQuery({ queryKey: ["connections", "list"], queryFn: listConnections });
  const providers = useQuery({ queryKey: ["connections", "providers"], queryFn: listConnectionProviders });
  const usage = useQuery({ queryKey: ["connections", "usage", removing], queryFn: () => connectionUsage(removing!), enabled: Boolean(removing) });
  const authorize = useMutation({ mutationFn: ({ provider, id }: { provider: string; id?: string }) => startConnection(provider, id),
    onSuccess: ({ url }) => window.location.assign(url) });
  useEffect(() => {
    if (!outcome) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("connectionResult");
    url.searchParams.delete("connectionResultId");
    window.history.replaceState(window.history.state, "", url);
    void client.invalidateQueries({ queryKey: ["connections"] });
  }, [client, outcome]);
  const disconnect = useMutation({ mutationFn: disconnectConnection, onSuccess: async () => {
    setRemoving(null);
    await Promise.all([
      client.invalidateQueries({ queryKey: ["connections"] }),
      client.invalidateQueries({ queryKey: TASKS_QUERY_KEY }),
      client.invalidateQueries({ queryKey: [TASK_RECORD_QUERY_KEY] }),
    ]);
  } });
  const requestAuthorization = (provider: string, id?: string) => {
    authorize.reset();
    if (mailProviderName(provider)) setConsent({ provider, id });
    else {
      setConsent(null);
      authorize.mutate({ provider, id });
    }
  };
  const confirmation = (provider: string, id?: string) => consent?.provider === provider && consent.id === id && (
    <div className="connection-impact" role="group" aria-label={t("connections.mail_consent_title", { provider: mailProviderName(provider) })}>
      <p>{t("connections.mail_consent")}</p>
      <div className="connection-actions">
        <Button type="button" disabled={authorize.isPending} onClick={() => authorize.mutate(consent)}>
          {t("connections.continue_to_provider", { provider: mailProviderName(provider) })}
        </Button>
        <Button type="button" variant="outline" disabled={authorize.isPending} onClick={() => setConsent(null)}>
          {t("connections.cancel")}
        </Button>
      </div>
    </div>
  );
  if (connections.isPending || providers.isPending) return <p role="status">{t("connections.loading")}</p>;
  if (connections.error || providers.error) return <div role="alert">{t("connections.load_failed")} <Button variant="outline" onClick={() => {
    void connections.refetch(); void providers.refetch();
  }}>{t("connections.retry")}</Button></div>;
  const records = connections.data?.connections ?? [];
  const connectedMailbox = outcome?.result === "connected"
    ? records.find(record => record.id === outcome.id && record.status === "connected" && mailProviderName(record.provider))
    : undefined;
  return <div className="connections-section">
    <p className="connections-hint">{t("connections.intro")}</p>
    {(authorize.error || disconnect.error) && <p role="alert">{t("connections.action_failed")}</p>}
    {outcome && <p role={connectedMailbox || outcome.result === "cancelled" ? "status" : "alert"}>
      {connectedMailbox ? t("connections.authorization_result.connected", { identity: connectedMailbox.identity })
        : t(`connections.authorization_result.${outcome.result === "connected" ? "failed" : outcome.result}`)}
    </p>}
    <section aria-labelledby="your-connections">
      <h3 id="your-connections" className="pref-group-label">{t("connections.yours")}</h3>
      {!records.length && <p className="connections-hint">{t("connections.empty")}</p>}
      {records.map(connection => <div className="connection-row" key={connection.id}>
        <div className="connection-overview">
          <ProviderMark provider={connection.provider} />
          <div className="connection-identity">
            <span className="pref-option-label">{providers.data?.providers.find(p => p.id === connection.provider)?.name} · {connection.label}</span>
            {(!mailProviderName(connection.provider) || connection.identity !== connection.label) &&
              <span className="pref-option-sub">{connection.identity}</span>}
            {connection.tenantLabel && <span className="pref-option-sub">{t("connections.organization", { tenant: connection.tenantLabel })}</span>}
            <Badge variant={connection.status === "connected" ? "neutral" : "warning"}>{t(`connections.status.${connection.status}`)}</Badge>
          </div>
        </div>
        <div className="connection-actions">
          {connection.status !== "connected" && <Button type="button" variant="outline" disabled={authorize.isPending}
            onClick={() => requestAuthorization(connection.provider, connection.id)}>{t("connections.reconnect")}</Button>}
          <Button type="button" variant="ghost" onClick={() => setRemoving(connection.id)}>{t("connections.disconnect")}</Button>
        </div>
        {confirmation(connection.provider, connection.id)}
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
        <div className="connection-overview">
          <ProviderMark provider={provider.id} />
          <div className="connection-identity"><span className="pref-option-label">{provider.name}</span>
            <span className="pref-option-sub">{t(provider.configured ? `connections.provider_hint.${provider.id}` : "connections.not_configured")}</span>
          </div>
        </div>
        {provider.configured && <Button type="button" variant="outline" disabled={authorize.isPending}
          aria-label={`${t("connections.connect")} ${provider.name}`}
          onClick={() => requestAuthorization(provider.id)}>{t(records.some(c => c.provider === provider.id) ? "connections.add_another" : "connections.connect")}</Button>}
        {confirmation(provider.id)}
      </div>)}
    </section>
  </div>;
}

function ProviderMark({ provider }: { provider: string }) {
  if (provider === "github") return <GithubMark size={ICON.xl} className="connection-provider-mark" />;
  return mailProviderName(provider) ? <AdminInbox size={ICON.xl} className="connection-provider-mark" aria-hidden="true" /> : null;
}
