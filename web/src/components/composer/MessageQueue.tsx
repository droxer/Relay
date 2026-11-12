import { useTranslation } from "react-i18next";
import type { QueuedMessage } from "../../lib/threadQueue";
import { Button } from "@/components/ui/button";
import { ActionFollowUp, ActionRemove, ICON } from "../icons";

// Messages written while the thread's run was going, docked on the composer's
// top edge: they belong to the next round, not the transcript. One quiet line
// each — the head goes on its own when the run ends; any row can be picked to
// steer (stop the live run and send that one instead).
export function MessageQueue({ messages, running, pending, paused, waiting, sending, error, onResume, onSteer, onEdit, onRemove }: {
  messages: readonly QueuedMessage[];
  running: boolean;
  pending?: boolean;
  paused?: boolean;
  waiting?: boolean;
  sending?: string;
  error?: string | null;
  onResume?: () => void;
  onSteer: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (messages.length === 0 && !error) return null;
  return (
    <section className="message-queue" aria-label={t("queue.title", { count: messages.length })}>
      {messages.length > 0 ? <div className="message-queue-status" role="status">
        <span>{t(sending ? "queue.sending" : paused ? "queue.paused" : waiting ? "queue.waiting" : "queue.saved", { count: messages.length })}</span>
        {paused ? <Button size="xs" variant="ghost" disabled={pending} onClick={onResume}>{t("queue.resume")}</Button> : null}
      </div> : null}
      {error ? <p className="message-queue-error" role="alert">{error}</p> : null}
      <ol className="message-queue-list">
        {messages.map((message, index) => (
          <li key={message.id} className="message-queue-item">
            <ActionFollowUp size={ICON.sm} className="message-queue-glyph" aria-hidden="true" />
            {/* The message is its own edit control: picking it puts it back in the box. */}
            <button type="button" className="message-queue-text" title={message.text}
              aria-label={t("queue.edit_item", { number: index + 1 })}
              disabled={pending || sending === message.id}
              onClick={() => onEdit(message.id)}>
              {message.text}
            </button>
            <div className="message-queue-actions">
              <Button type="button" size="xs" variant="ghost"
                tooltip={running ? t("queue.steer_hint") : undefined}
                aria-label={t(running ? "queue.steer_item" : "queue.send_item", { number: index + 1 })}
                disabled={pending || !!sending}
                onClick={() => onSteer(message.id)}>
                {running ? t("queue.steer") : t("queue.send_now")}
              </Button>
              <Button type="button" size="icon-xs" variant="icon"
                aria-label={t("queue.remove_item", { number: index + 1 })} tooltip={t("queue.remove")}
                disabled={pending || sending === message.id}
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
