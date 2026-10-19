"use client";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getComputerSetupCommand } from "../../api";
import { Button } from "../ui/button";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { ComputerKindPicker } from "./ComputerKindPicker";
import { OsInstallCommand, TargetOsTabs } from "./TargetOsTabs";

export function ComputerDeviceSetup({ onManual }: { onManual: () => void }) {
  const { t } = useTranslation();
  const [command, setCommand] = useState<string>();
  const [windowsCommand, setWindowsCommand] = useState<string>();
  const [error, setError] = useState(false);
  const { copy, copiedField } = useCopyFeedback();
  useEffect(() => {
    let active = true;
    void getComputerSetupCommand().then(result => {
      if (!active) return;
      setCommand(result.installCommand);
      setWindowsCommand(result.windowsInstallCommand);
    })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);
  return <div className="adm-form">
    <ComputerKindPicker />
    <TargetOsTabs>
      {(os) => <ol className="computer-install-steps">
        <li><h3>{t("computer.connect_command_step")}</h3>
          <OsInstallCommand os={os} unixCommand={command} windowsCommand={windowsCommand}
            loading={!command && !error} copied={copiedField === `device-setup-${os}`}
            onCopy={(value) => { void copy(`device-setup-${os}`, value); }} /></li>
        <li>{t("computer.device_choose_directory")}</li>
        <li>{t("computer.device_confirm_browser")}</li>
      </ol>}
    </TargetOsTabs>
    <p className="adm-form-hint">{t("computer.connect_requirements")}</p>
    <Button variant="ghost" className="computer-manual-link" onClick={onManual}>{t("computer.device_manual")}</Button>
  </div>;
}
