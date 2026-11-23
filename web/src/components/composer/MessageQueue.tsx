import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QueuedMessage } from "../../lib/threadQueue";
import { Button } from "@/components/ui/button";
import { ActionFollowUp, ActionRemove, ICON } from "../icons";
import { identityMonogram } from "../../lib/identity";

/** Pills before the rest fold into a "+N" chip, so the message text keeps the row. */
const MAX_RECIPIENT_PILLS = 2;

/** Future instructions stay on the composer; inspecting them never changes their schedule. */
export function MessageQueue({ messages, running, pending, paused, waiting, sending, error, recipientNames = {}, removedAt, onUndo, onResume, onSteer, onEdit, onRemove }: {
  messages: readonly QueuedMessage[];
  running: boolean;
  pending?: boolean;
  paused?: boolean;
  waiting?: boolean;
  sending?: string;
  error?: string | null;
  recipientNames?: Record<string, string>;
  removedAt?: string;
  onUndo?: () => void;
  onResume?: () => void;
  onSteer: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expiredRemoval, setExpiredRemoval] = useState<string | undefined>();
  const regionId = useId();
  const deadline = removedAt ? Date.parse(removedAt) + 5000 : 0;
  const undoAvailable = !!removedAt && Number.isFinite(deadline) && expiredRemoval !== removedAt;
  useEffect(() => {
    if (!removedAt || !Number.isFinite(deadline)) return;
    const timer = setTimeout(() => setExpiredRemoval(removedAt), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [removedAt, deadline]);
  if (messages.length === 0 && !error && !undoAvailable) return null;
  const status = sending ? "queue.sending"
    : paused ? "queue.paused"
    : waiting ? "queue.waiting"
    : running ? "queue.saved"
    : "queue.ready";
  return (
    <section className="message-queue" aria-label={t("queue.title", { count: messages.length })}>
      {messages.length > 0 ? <div className="message-queue-status" role="status">
        <span>{t(status, { count: messages.length })}</span>
        {paused ? <Button type="button" size="xs" variant="ghost" disabled={pending} onClick={onResume}>{t("queue.resume")}</Button> : null}
      </div> : null}
      {error ? <p className="message-queue-error" role="alert">{error}</p> : null}
      {undoAvailable ? <div className="message-queue-status" role="status">
        <span>{t("queue.removed")}</span>
        <Button type="button" size="xs" variant="ghost" disabled={pending} onClick={onUndo}>{t("queue.undo")}</Button>
      </div> : null}
      <ol className="message-queue-list">
        {messages.map((message, index) => {
          const open = expanded === message.id;
          const recipientIds = message.addressTeamId ? [message.addressTeamId] : message.addressAgentIds ?? [];
          const shown = recipientIds.slice(0, MAX_RECIPIENT_PILLS);
          const overflow = recipientIds.slice(MAX_RECIPIENT_PILLS).map(id => recipientNames[id] ?? t("queue.recipient_unavailable"));
          const previewId = `${regionId}-${index}`;
          return (
            <li key={message.id} className="message-queue-item" data-expanded={open || undefined}>
              <ActionFollowUp size={ICON.sm} className="message-queue-glyph" aria-hidden="true" />
              <div className="message-queue-content">
                <button type="button" className="message-queue-text" aria-expanded={open}
                  aria-controls={open ? previewId : undefined}
                  aria-label={`${t(open ? "queue.collapse_item" : "queue.preview_item", { number: index + 1 })}: ${message.text}`}
                  onClick={() => setExpanded(open ? null : message.id)}>
                  <span className="message-queue-recipients">
                    {shown.length ? shown.map(id => {
                      const name = recipientNames[id];
                      return (
                        <span key={id} className="message-queue-recipient" data-unavailable={name ? undefined : true}>
                          {name ? <span className="message-queue-recipient-mark" aria-hidden="true">{identityMonogram(name)}</span> : null}
                          <span className="message-queue-recipient-name">{name ?? t("queue.recipient_unavailable")}</span>
                        </span>
                      );
                    }) : (
                      <span className="message-queue-recipient" data-room>
                        <span className="message-queue-recipient-name">{t("queue.room_recipient")}</span>
                      </span>
                    )}
                    {overflow.length ? <span className="message-queue-recipient" data-overflow title={overflow.join(t("queue.recipient_separator"))}>
                      +{overflow.length}
                    </span> : null}
                  </span>
                  <span className="message-queue-summary" dir="auto">{open ? t("queue.collapse_item", { number: index + 1 }) : message.text}</span>
                </button>
              </div>
              <div className="message-queue-actions">
                <Button type="button" size="xs" variant="ghost"
                  tooltip={running ? t("queue.steer_hint") : undefined}
                  aria-label={t(running ? "queue.steer_item" : "queue.send_item", { number: index + 1 })}
                  disabled={pending || !!sending} onClick={() => onSteer(message.id)}>
                  {running ? t("queue.steer") : t("queue.send_now")}
                </Button>
                <Button type="button" size="icon-xs" variant="icon"
                  aria-label={t("queue.remove_item", { number: index + 1 })} tooltip={t("queue.remove")}
                  disabled={pending || sending === message.id} onClick={() => onRemove(message.id)}>
                  <ActionRemove size={ICON.sm} />
                </Button>
              </div>
              {open ? <div id={previewId} className="message-queue-preview">
                <p dir="auto">{message.text}</p>
                <Button type="button" size="xs" variant="ghost" aria-label={t("queue.edit_item", { number: index + 1 })}
                  disabled={pending || sending === message.id} onClick={() => onEdit(message.id)}>{t("queue.move_to_draft")}</Button>
              </div> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
