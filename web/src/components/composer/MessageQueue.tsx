import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { QueuedMessage } from "../../lib/threadQueue";
import { Button } from "@/components/ui/button";
import { ActionEdit, ActionRemove, ActionSend, ICON } from "../icons";

// Messages written while the thread's run was going, docked on the composer's
// top edge the way an awaiting-input prompt is: they belong to the next round,
// not the transcript. The head goes on its own when the run ends; any row can
// be picked to steer — stop the live run and send that one instead.
export function MessageQueue({ messages, running, onSteer, onEdit, onRemove }: {
  messages: readonly QueuedMessage[];
  running: boolean;
  onSteer: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  if (messages.length === 0) return null;
  return (
    <section className="message-queue" aria-labelledby={headingId}>
      <div className="message-queue-head">
        <h2 id={headingId} className="message-queue-title">{t("queue.title", { count: messages.length })}</h2>
        <span className="message-queue-hint">{running ? t("queue.hint_running") : t("queue.hint_idle")}</span>
      </div>
      <ol className="message-queue-list">
        {messages.map((message, index) => (
          <li key={message.id} className="message-queue-item" data-head={index === 0 || undefined}>
            <span className="message-queue-index" aria-hidden="true">{index + 1}</span>
            <p className="message-queue-text">{message.text}</p>
            <div className="message-queue-actions">
              <Button type="button" size="xs" variant={index === 0 ? "default" : "outline"}
                tooltip={running ? t("queue.steer_hint") : undefined}
                aria-label={t(running ? "queue.steer_item" : "queue.send_item", { number: index + 1 })}
                onClick={() => onSteer(message.id)}>
                <ActionSend size={ICON.sm} aria-hidden="true" />
                {running ? t("queue.steer") : t("queue.send_now")}
              </Button>
              <Button type="button" size="icon-xs" variant="icon"
                aria-label={t("queue.edit_item", { number: index + 1 })} tooltip={t("queue.edit")}
                onClick={() => onEdit(message.id)}>
                <ActionEdit size={ICON.sm} />
              </Button>
              <Button type="button" size="icon-xs" variant="icon"
                aria-label={t("queue.remove_item", { number: index + 1 })} tooltip={t("queue.remove")}
                onClick={() => onRemove(message.id)}>
                <ActionRemove size={ICON.sm} />
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
