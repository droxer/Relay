import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QueuedMessage } from "../../lib/threadQueue";
import { Button } from "@/components/ui/button";
import { ActionFollowUp, ActionRemove, ICON } from "../icons";

/** Future instructions stay on the composer; inspecting them never changes their schedule. */
export function MessageQueue({ messages, running, pending, paused, waiting, sending, error, recipientNames = {}, undoAvailable, onUndo, onResume, onSteer, onEdit, onRemove }: {
  messages: readonly QueuedMessage[];
  running: boolean;
  pending?: boolean;
  paused?: boolean;
  waiting?: boolean;
  sending?: string;
  error?: string | null;
  recipientNames?: Record<string, string>;
  undoAvailable?: boolean;
  onUndo?: () => void;
  onResume?: () => void;
  onSteer: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);
  const regionId = useId();
  if (messages.length === 0 && !error && !undoAvailable) return null;
  return (
    <section className="message-queue" aria-label={t("queue.title", { count: messages.length })}>
      {messages.length > 0 ? <div className="message-queue-status" role="status">
        <span>{t(sending ? "queue.sending" : paused ? "queue.paused" : waiting ? "queue.waiting" : "queue.saved", { count: messages.length })}</span>
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
          const recipients = recipientIds.length ? recipientIds.map(id => recipientNames[id] ?? t("queue.recipient_unavailable")).join(t("queue.recipient_separator")) : t("queue.room_recipient");
          const previewId = `${regionId}-${index}`;
          return (
            <li key={message.id} className="message-queue-item" data-expanded={open || undefined}>
              <ActionFollowUp size={ICON.sm} className="message-queue-glyph" aria-hidden="true" />
              <div className="message-queue-content">
                <button type="button" className="message-queue-text" aria-expanded={open}
                  aria-controls={open ? previewId : undefined}
                  aria-label={`${t(open ? "queue.collapse_item" : "queue.preview_item", { number: index + 1 })}: ${message.text}`}
                  onClick={() => setExpanded(open ? null : message.id)}>
                  {recipients ? <span className="message-queue-recipient">{recipients}</span> : null}
                  <span className="message-queue-summary">{open ? t("queue.collapse_item", { number: index + 1 }) : message.text}</span>
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
