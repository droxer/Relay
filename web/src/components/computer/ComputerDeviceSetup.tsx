"use client";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getComputerSetupCommand } from "../../api";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import { isNodeOnline } from "../../lib/adminHelpers";
import { Button } from "../ui/button";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { OsInstallCommand, TargetOsTabs } from "./TargetOsTabs";

export function ComputerDeviceSetup({
  nodes = [],
  onManual,
}: {
  nodes?: readonly ControlPanelDaemonNodeRecord[];
  onManual: () => void;
}) {
  const { t } = useTranslation();
  const [command, setCommand] = useState<string>();
  const [windowsCommand, setWindowsCommand] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [baselineOnlineIds] = useState<ReadonlySet<string>>(
    () => new Set(nodes.filter(isNodeOnline).map((node) => node.id)),
  );
  const { copy, copiedField } = useCopyFeedback();

  useEffect(() => {
    let active = true;
    void getComputerSetupCommand().then(result => {
      if (!active) return;
      setError(false);
      setCommand(result.installCommand);
      setWindowsCommand(result.windowsInstallCommand);
    })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);

  const connected = nodes.some((node) => isNodeOnline(node) && !baselineOnlineIds.has(node.id));

  function handleRetry() {
    setError(false);
    setCommand(undefined);
    setWindowsCommand(undefined);
    setAttempt((value) => value + 1);
  }

  return <div className="adm-form">
    <TargetOsTabs>
      {(os) => <ol className="computer-install-steps">
        <li><h3>{t("computer.connect_command_step")}</h3>
          <OsInstallCommand os={os} unixCommand={command} windowsCommand={windowsCommand}
            loading={!command && !error} copied={copiedField === `device-setup-${os}`}
            onCopy={(value) => { void copy(`device-setup-${os}`, value); }}
            onRetry={error ? handleRetry : undefined} /></li>
        <li><h3>{t("computer.device_choose_directory")}</h3></li>
        <li><h3>{t("computer.device_confirm_browser")}</h3></li>
      </ol>}
    </TargetOsTabs>
    <div className="computer-install-status" role="status" data-connected={connected}>
      <strong>{t(connected ? "computer.connect_online" : "computer.connect_waiting")}</strong>
      <p>{t(connected ? "computer.connect_online_hint" : "computer.connect_waiting_hint")}</p>
    </div>
    <p className="adm-form-hint">{t("computer.connect_requirements")}</p>
    <Button type="button" variant="ghost" className="computer-manual-link" onClick={onManual}>{t("computer.device_manual")}</Button>
  </div>;
}
