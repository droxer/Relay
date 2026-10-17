import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PermissionRequest } from "relay-core";
import { ActionApprove, ICON } from "../icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { permissionInputText, permissionNoteReachesAgent } from "@/lib/permissionRequests";

type Answer = (requestId: string, decision: "allow" | "deny", note?: string) => Promise<void>;

/** Mirrors `PERMISSION_NOTE_MAX_CHARS` in backend/relay/core/permission_requests.py. */
const NOTE_MAX_CHARS = 1000;

/**
 * The prompts a live run is paused on: one card per tool call it asked to
 * make, oldest first, each answered on its own. The run resumes when its
 * prompt is answered, so the card leaves once the thread's stream closes it.
 */
export function PermissionPrompts({ requests, agentLabel, onAnswer }: {
  requests: PermissionRequest[];
  /** The asking run's agent, named the way the transcript names it. */
  agentLabel: (request: PermissionRequest) => string;
  onAnswer: Answer;
}) {
  const { t } = useTranslation();
  if (requests.length === 0) return null;
  return (
    <section className="permission-prompts" aria-label={t("permission.region")}>
      {requests.map((request, index) => (
        <PermissionPrompt
          key={request.id}
          request={request}
          agent={agentLabel(request)}
          autoFocus={index === 0}
          onAnswer={onAnswer}
        />
      ))}
    </section>
  );
}

function PermissionPrompt({ request, agent, autoFocus, onAnswer }: {
  request: PermissionRequest;
  agent: string;
  autoFocus: boolean;
  onAnswer: Answer;
}) {
  const { t } = useTranslation();
  const allowRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);

  // A paused run is easy to miss mid-transcript; move focus to the answer.
  useEffect(() => {
    if (autoFocus) allowRef.current?.focus();
  }, [autoFocus]);

  const answer = async (decision: "allow" | "deny") => {
    if (pending) return;
    setPending(decision);
    try {
      await onAnswer(request.id, decision, note.trim() || undefined);
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;
  const pendingLabel = t("decision.pending");
  return (
    <div className="permission-prompt" role="group" aria-labelledby={`${id}-title`}>
      <div className="permission-prompt-head">
        <span id={`${id}-title`} className="permission-prompt-title">
          {t("permission.title", { agent, tool: request.toolName })}
        </span>
        <span className="permission-prompt-summary">{t("permission.summary")}</span>
      </div>
      {request.input ? (
        <pre className="permission-prompt-input" aria-label={t("permission.input_label")}>
          {permissionInputText(request.input)}
        </pre>
      ) : null}
      {permissionNoteReachesAgent(request) ? (
        <div className="permission-prompt-note">
          <Label htmlFor={`${id}-note`}>{t("permission.note_label")}</Label>
          <Input
            id={`${id}-note`}
            name="permission-note"
            autoComplete="off"
            maxLength={NOTE_MAX_CHARS}
            placeholder={t("permission.note_placeholder")}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      ) : null}
      <div className="decision-bar">
        <Button variant="default" type="button" ref={allowRef} disabled={busy} loading={pending === "allow"} loadingLabel={pendingLabel} onClick={() => void answer("allow")}>
          <ActionApprove size={ICON.sm} /> {t("permission.allow")}
        </Button>
        <Button variant="destructive" type="button" disabled={busy} loading={pending === "deny"} loadingLabel={pendingLabel} onClick={() => void answer("deny")}>
          {t("permission.deny")}
        </Button>
      </div>
    </div>
  );
}
