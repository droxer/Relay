import { useTranslation } from "react-i18next";
import type { QueuedMessage } from "../../lib/threadQueue";
import { Button } from "@/components/ui/button";
import { ActionFollowUp, ActionRemove, ICON } from "../icons";

// Messages written while the thread's run was going, docked on the composer's
// top edge: they belong to the next round, not the transcript. One quiet line
// each — the head goes on its own when the run ends; any row can be picked to
// steer (stop the live run and send that one instead).
export function MessageQueue({ messages, running, onSteer, onEdit, onRemove }: {
  messages: readonly QueuedMessage[];
  running: boolean;
  onSteer: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (messages.length === 0) return null;
  return (
    <section className="message-queue" aria-label={t("queue.title", { count: messages.length })}>
      <ol className="message-queue-list">
        {messages.map((message, index) => (
          <li key={message.id} className="message-queue-item">
            <ActionFollowUp size={ICON.sm} className="message-queue-glyph" aria-hidden="true" />
            {/* The message is its own edit control: picking it puts it back in the box. */}
            <button type="button" className="message-queue-text" title={message.text}
              aria-label={t("queue.edit_item", { number: index + 1 })}
              onClick={() => onEdit(message.id)}>
              {message.text}
            </button>
            <div className="message-queue-actions">
              <Button type="button" size="xs" variant="ghost"
                tooltip={running ? t("queue.steer_hint") : undefined}
                aria-label={t(running ? "queue.steer_item" : "queue.send_item", { number: index + 1 })}
                onClick={() => onSteer(message.id)}>
                {running ? t("queue.steer") : t("queue.send_now")}
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
