import { useTranslation } from "react-i18next";
import type { DirectDelegationView } from "../lib/directDelegations";

export function DirectDelegationCard({ delegation, names }: {
  delegation: DirectDelegationView;
  names?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const requester = names?.[delegation.requestedByAgentId] ?? t("delegation.requester");
  const target = names?.[delegation.targetAgentId] ?? t("delegation.delegate");
  const report = delegation.child?.workResult;
  return (
    <details className="direct-delegation">
      <summary>
        <span>{t("delegation.receipt", { requester, target })}</span>
        <span className="direct-delegation-objective">{delegation.objective}</span>
        <span className="direct-delegation-status">{t(`delegation.status.${delegation.status}`)}</span>
      </summary>
      {delegation.context ? <p>{delegation.context}</p> : null}
      <h3>{t("delegation.expected_outputs")}</h3>
      <ul>{delegation.expectedOutputs.map((output) => <li key={output}>{output}</li>)}</ul>
      <h3>{t("delegation.acceptance_criteria")}</h3>
      <ul>{delegation.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
      {report ? (
        <>
          <h3>{t("delegation.returned_report", { target })}</h3>
          <p>{t(`delegation.work_status.${report.status}`)}{report.note ? `: ${report.note}` : ""}</p>
          {report.evidence.length ? <ul>{report.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul> : null}
        </>
      ) : delegation.child?.status === "failed" ? <p>{t("delegation.runtime_failed", { target })}</p> : null}
      <p className="direct-delegation-note">{t("delegation.accountability", { requester })}</p>
    </details>
  );
}
