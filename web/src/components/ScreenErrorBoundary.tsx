"use client";

import { Component, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

function ErrorFallback() {
  const { t } = useTranslation();
  return (
    <section className="route-loading" role="alert">
      <h1>{t("errors.screen_failed")}</h1>
      <p>{t("errors.screen_failed_body")}</p>
      {/* The real Button, not a bare <button>: base.css leaves an unslotted
          button with no border and no fill, so the app's only recovery control
          rendered as plain text on the one screen where it has to look
          pressable. Adding the primitive to the recovery path is safe in the
          way that matters — if Button itself were the thing that broke, the 83
          surfaces that use it would already be down. */}
      <Button variant="outline" type="button" onClick={() => window.location.reload()}>{t("errors.reload_app")}</Button>
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
