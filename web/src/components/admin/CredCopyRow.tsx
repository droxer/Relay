"use client";

import { useTranslation } from "react-i18next";
import {
  ActionApprove,
  ActionCopy,
  ICON,
} from "../icons";
import { Button } from "@/components/ui/button";

interface CredCopyRowProps {
  label: string;
  value: string;
  copyLabel: string;
  copied: boolean;
  onCopy: () => void;
  hint?: string;
}

export function CredCopyRow({ label, value, copyLabel, copied, onCopy, hint }: CredCopyRowProps) {
  const { t } = useTranslation();
  return (
    <div className="adm-cred-row">
      <span className="adm-cred-label">{label}</span>
      {hint ? <span className="adm-cred-hint">{hint}</span> : null}
      <div className="adm-cred-value-line">
        <code className="adm-cred-value code" translate="no">{value}</code>
        {/* Filled cobalt pill. The variant paints the plate now — the class
            carries only the confirmed state. */}
        <Button
          variant="default"
          size="dense"
          type="button"
          className={`adm-copy-pill ${copied ? "copied" : ""}`}
          onClick={onCopy}
          tooltip={copyLabel}
        >
          {copied ? <ActionApprove size={ICON.sm} aria-hidden="true" /> : <ActionCopy size={ICON.sm} aria-hidden="true" />}
          <span>{copied ? t("admin.copied") : t("admin.copy")}</span>
          <span className="sr-only" aria-live="polite">{copied ? t("admin.copied") : ""}</span>
        </Button>
      </div>
    </div>
  );
}
