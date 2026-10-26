"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  approveComputerAuthorization,
  getComputerAuthorization,
  RelayApiError,
  type ComputerAuthorizationDetails,
} from "../../api";
import type { CurrentUser } from "../../types";
import { AuthCanvas } from "../AuthCanvas";
import { Button } from "../ui/button";

type ApprovalOutcome = "approved" | "expired" | "failed" | null;

/**
 * `/computers?connect=<code>` — the page `relay setup` opens in the browser.
 * It asks one question: connect the computer and directory the terminal
 * named, under the account signed in here. It stands on the same gate as
 * sign-in and password reset, so granting a machine access reads as a
 * deliberate step rather than a loading screen. The terminal polls the whole
 * time and finishes on its own once approved, so the page's last job is to
 * send the person back there.
 */
export function DeviceApproval({ code, user }: { code: string; user: CurrentUser }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ApprovalOutcome>(null);

  const request = useQuery({
    queryKey: ["computer-authorization", code],
    queryFn: () => getComputerAuthorization(code),
    retry: false,
    staleTime: Infinity,
  });
  const details = request.data;
  const lookupExpired = request.error instanceof RelayApiError && request.error.status === 410;
  const expired = lookupExpired || outcome === "expired";
  const approved = outcome === "approved" || (details !== undefined && details.status !== "pending");

  async function approve() {
    setBusy(true);
    setOutcome(null);
    try {
      await approveComputerAuthorization(code);
      setOutcome("approved");
    } catch (err) {
      setOutcome(approvalFailure(err));
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <AuthCanvas mode="connect-computer">
        <div className="login-panel-head">
          <h2 className="login-panel-title">{t("computer.device_expired_title")}</h2>
          <p className="login-note">{t("computer.device_expired_body")}</p>
        </div>
        <ComputersLink />
      </AuthCanvas>
    );
  }

  return (
    <AuthCanvas mode="connect-computer">
      <div className="login-panel-head">
        <h2 className="login-panel-title" id="device-approval-title">
          {approved ? t("computer.device_approved_title") : t("computer.device_approval_title")}
        </h2>
        <p className="login-note" role={approved ? "status" : undefined}>
          {approved ? t("computer.device_approved") : t("computer.device_approval_lede")}
        </p>
      </div>

      {details ? <RequestFacts details={details} user={user} /> : null}

      {request.isPending ? (
        <p className="login-note" role="status">{t("computer.device_checking")}</p>
      ) : request.isError ? (
        <>
          <p className="login-error" role="alert">{t("computer.device_error")}</p>
          <Button type="button" className="login-submit w-full" size="lg"
            loading={request.isFetching} onClick={() => void request.refetch()}>
            {t("computer.device_retry")}
          </Button>
        </>
      ) : approved ? (
        <ComputersLink />
      ) : (
        <>
          <p className="login-note">{t("computer.device_approval_scope")}</p>
          {outcome === "failed" ? <p className="login-error" role="alert">{t("computer.device_error")}</p> : null}
          <Button type="button" className="login-submit w-full" size="lg" loading={busy}
            onClick={() => void approve()}>
            {t("computer.device_approve")}
          </Button>
          <p className="login-alt">{t("computer.device_not_me")}</p>
        </>
      )}
    </AuthCanvas>
  );
}

/** What the terminal asked for, and who would own it: the three facts a
    person needs to recognise their own setup before granting it. */
function RequestFacts({ details, user }: { details: ComputerAuthorizationDetails; user: CurrentUser }) {
  const { t } = useTranslation();
  const account = user.displayName ? `${user.displayName} (@${user.username})` : `@${user.username}`;
  return (
    <dl className="login-facts">
      <div>
        <dt>{t("computer.device_fact_name")}</dt>
        <dd>{details.displayName}</dd>
      </div>
      <div>
        <dt>{t("computer.device_fact_workspace")}</dt>
        <dd><code>{details.workspacePath}</code></dd>
      </div>
      <div>
        <dt>{t("computer.device_fact_account")}</dt>
        <dd>{account}</dd>
      </div>
    </dl>
  );
}

/** A full load, not an in-app push: the app chose this page from the address
    it booted on, so leaving it means booting the app again. */
function ComputersLink() {
  const { t } = useTranslation();
  return (
    <p className="login-alt">
      <a className="login-link" href="/computers">{t("computer.device_open_computers")}</a>
    </p>
  );
}

function approvalFailure(err: unknown): ApprovalOutcome {
  if (!(err instanceof RelayApiError)) return "failed";
  // 409: another tab or a double click already approved this request.
  if (err.status === 409) return "approved";
  if (err.status === 410) return "expired";
  return "failed";
}
