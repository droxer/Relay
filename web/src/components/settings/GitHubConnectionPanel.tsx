"use client";

import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { AdminConnect } from "../icons";

/** Public issue imports are available; account connection is deferred. */
export function GitHubConnectionPanel() {
  const { t } = useTranslation();
  return (
    <section className="github-connection" aria-label={t("github_connection.title")}>
      <h3 className="github-connection-title">
        <AdminConnect aria-hidden="true" />
        {t("github_connection.title")}
        <Badge variant="neutral">{t("github_connection.coming_soon")}</Badge>
      </h3>
      <p className="github-connection-hint">{t("github_connection.public_only")}</p>
    </section>
  );
}

/** The same connection as one row of the Account section's Connections
    list, the row shape a notification toggle uses. */
export function GitHubConnectionRow() {
  const { t } = useTranslation();
  return (
    <div className="pref-option-list">
      <div className="github-connection-row">
        <span className="github-connection-mark" aria-hidden="true"><AdminConnect /></span>
        <span className="pref-option-copy">
          <span className="pref-option-label">{t("github_connection.title")}</span>
          <span className="pref-option-sub">{t("github_connection.public_only")}</span>
        </span>
        <Badge variant="neutral">{t("github_connection.coming_soon")}</Badge>
      </div>
    </div>
  );
}
