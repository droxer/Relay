"use client";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { approveComputerAuthorization, getComputerAuthorization, type ComputerAuthorizationDetails } from "../../api";
import { Button } from "../ui/button";
import { Alert } from "../ui/alert";

export function DeviceApproval({ code }: { code: string }) {
  const { t } = useTranslation();
  const [details, setDetails] = useState<ComputerAuthorizationDetails>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  useEffect(() => {
    let active = true;
    setDetails(undefined); setError(false); setApproved(false);
    void getComputerAuthorization(code).then(result => { if (active) setDetails(result); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [code]);
  async function approve() {
    setBusy(true); setError(false);
    try { await approveComputerAuthorization(code); setApproved(true); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  return <main className="login-checking">
    <section className="adm-form">
      <h1>{t("computer.device_approval_title")}</h1>
      {details && <><p>{details.displayName}</p><code>{details.workspacePath}</code></>}
      {approved || (details && details.status !== "pending") ? <p role="status">{t("computer.device_approved")}</p> : <>
        <p>{t("computer.device_approval_scope")}</p>
        <Button disabled={!details || busy} onClick={() => { void approve(); }}>{t("computer.device_approve")}</Button>
      </>}
      {error && <Alert>{t("computer.device_error")}</Alert>}
      <a href="/computer">{t("computer.title")}</a>
    </section>
  </main>;
}
