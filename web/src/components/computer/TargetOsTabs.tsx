"use client";

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert } from "@/components/ui/alert";
import { CredCopyRow } from "../admin/CredCopyRow";

export type TargetOs = "macos" | "linux" | "windows";

const TARGET_OSES: readonly TargetOs[] = ["macos", "linux", "windows"];

const OS_NAMES: Record<TargetOs, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

/** The browser's OS is only a starting guess: the target computer may differ,
 *  which is why it stays a tab the person can change. */
export function detectTargetOs(): TargetOs {
  if (typeof navigator === "undefined") return "macos";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""}`;
  if (/win/i.test(platform)) return "windows";
  if (/linux/i.test(platform) && !/android/i.test(nav.userAgent)) return "linux";
  return "macos";
}

interface TargetOsTabsProps {
  children: (os: TargetOs) => ReactNode;
}

/**
 * One tab per operating system. macOS and Linux share an installer script but
 * not a shell or a prerequisite, so each tab states its own support line and
 * the caller renders only the command that OS runs.
 */
export function TargetOsTabs({ children }: TargetOsTabsProps) {
  const { t } = useTranslation();
  const [os, setOs] = useState<TargetOs>(detectTargetOs);
  return (
    <Tabs value={os} onValueChange={(next) => setOs(next as TargetOs)} className="computer-os">
      <TabsList className="computer-os-tabs" aria-label={t("computer.os_tabs_label")}>
        {TARGET_OSES.map((option) => (
          <TabsTrigger key={option} value={option} className="computer-os-tab">
            {OS_NAMES[option]}
          </TabsTrigger>
        ))}
      </TabsList>
      {TARGET_OSES.map((option) => (
        <TabsContent key={option} value={option} className="computer-os-panel">
          <p className="computer-os-support">{t(`computer.platform_${option}`)}</p>
          {children(option)}
        </TabsContent>
      ))}
    </Tabs>
  );
}

interface OsInstallCommandProps {
  os: TargetOs;
  /** The macOS / Linux installer (or a legacy start command). */
  unixCommand?: string;
  windowsCommand?: string;
  loading?: boolean;
  copied: boolean;
  onCopy: (command: string) => void;
}

/** The selected OS's command, or why there is none. */
export function OsInstallCommand({ os, unixCommand, windowsCommand, loading, copied, onCopy }: OsInstallCommandProps) {
  const { t } = useTranslation();
  if (loading) return <p className="adm-form-hint">{t("computer.device_loading")}</p>;
  const command = os === "windows" ? windowsCommand : unixCommand;
  if (!command) {
    // Only an older server lacks the Windows installer alone; with no command
    // at all, the request itself failed.
    const windowsMissing = os === "windows" && Boolean(unixCommand);
    return <Alert>{t(windowsMissing ? "computer.os_windows_unavailable" : "computer.device_error")}</Alert>;
  }
  return (
    <CredCopyRow
      label={t("computer.connect_setup_os_label", { os: OS_NAMES[os] })}
      hint={t(`computer.os_shell_hint_${os}`)}
      value={command}
      copyLabel={t("computer.connect_setup_copy")}
      copied={copied}
      onCopy={() => onCopy(command)}
    />
  );
}
