"use client";

import { useTranslation } from "react-i18next";

/** Applies to the target computer, which may differ from the browser's OS. */
export function ComputerPlatformSupport() {
  const { t } = useTranslation();
  return (
    <section className="computer-install-intro" aria-label={t("computer.platform_support")}>
      <h3>{t("computer.platform_support")}</h3>
      <dl className="computer-platform-support">
        <div><dt>macOS</dt><dd>{t("computer.platform_macos")}</dd></div>
        <div><dt>Linux</dt><dd>{t("computer.platform_linux")}</dd></div>
        <div><dt>Windows</dt><dd>{t("computer.platform_windows")}</dd></div>
      </dl>
      <p>{t("computer.platform_shell_hint")}</p>
    </section>
  );
}
