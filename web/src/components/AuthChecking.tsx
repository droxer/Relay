"use client";

import { useTranslation } from "react-i18next";
import { useClientMounted } from "../hooks/useClientMounted";

/** The gate while the session is unknown. The prerendered HTML shows it too,
    before i18n is ready, so it falls back to fixed English until mounted. */
export function AuthChecking() {
  const { t } = useTranslation();
  const mounted = useClientMounted();
  return (
    <main className="login-checking" aria-busy="true">
      <p className="login-checking-text">
        {mounted ? t("login.checking") : "Checking authentication…"}
      </p>
    </main>
  );
}
