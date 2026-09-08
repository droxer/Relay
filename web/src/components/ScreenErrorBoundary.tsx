"use client";

import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

function ErrorFallback() {
  const { t } = useTranslation();
  return (
    <section className="route-loading" role="alert">
      <h1>{t("errors.screen_failed")}</h1>
      <p>{t("errors.screen_failed_body")}</p>
      <button type="button" onClick={() => window.location.reload()}>{t("errors.reload_app")}</button>
    </section>
  );
}

/** A different route remounts the failed screen; reload also recovers rejected lazy imports. */
export class ScreenErrorBoundary extends Component<{
  children: ReactNode;
  resetKey?: string;
}, { failed: boolean; resetKey?: string }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() { return { failed: true }; }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { resetKey?: string }) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  render() { return this.state.failed ? <ErrorFallback /> : this.props.children; }
}
