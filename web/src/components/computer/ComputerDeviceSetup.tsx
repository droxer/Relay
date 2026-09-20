"use client";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getComputerSetupCommand } from "../../api";
import { Button } from "../ui/button";
import { Alert } from "../ui/alert";
import { CredCopyRow } from "../admin/CredCopyRow";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { ComputerPlatformSupport } from "./ComputerPlatformSupport";

export function ComputerDeviceSetup({ onManual }: { onManual: () => void }) {
  const { t } = useTranslation();
  const [command, setCommand] = useState<string>();
  const [error, setError] = useState(false);
  const { copy, copiedField } = useCopyFeedback();
  useEffect(() => {
    let active = true;
    void getComputerSetupCommand().then(result => { if (active) setCommand(result.installCommand); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);
  return <div className="adm-form">
    <ComputerPlatformSupport />
    <p>{t("computer.connect_requirements")}</p>
    <ol className="computer-install-steps">
      <li>{command ? <CredCopyRow label={t("computer.connect_command_step")} value={command}
        copyLabel={t("computer.connect_setup_copy")} copied={copiedField === "device-setup"}
        onCopy={() => { void copy("device-setup", command); }} /> : <p>{t("computer.device_loading")}</p>}</li>
      <li>{t("computer.device_choose_directory")}</li>
      <li>{t("computer.device_confirm_browser")}</li>
    </ol>
    {error && <Alert>{t("computer.device_error")}</Alert>}
    <Button variant="ghost" onClick={onManual}>{t("computer.device_manual")}</Button>
  </div>;
}
