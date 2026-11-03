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
