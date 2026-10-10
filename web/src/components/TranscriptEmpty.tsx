import { useTranslation } from "react-i18next";
import { RelayEmptyState } from "./RelayEmptyState";
import { RelayMark } from "./RelayMark";
import { ActionPrompt, ICON } from "./icons";
import { sendShortcutLabel } from "../lib/sendShortcut";
import { Button } from "@/components/ui/button";

type TranscriptEmptyProps = {
  selectedEmployee: string;
  /** A starter chip drops its prompt into the composer and focuses it. */
  onSuggestion?: (text: string) => void;
};

const SUGGESTION_KEYS = ["plan", "review", "orient"] as const;

export function TranscriptEmpty({
  selectedEmployee,
  onSuggestion,
}: TranscriptEmptyProps) {
  const { t } = useTranslation();
  const ready = Boolean(selectedEmployee);
  const headline = ready
    ? t("transcript.ready_for")
    : t("transcript.ready_no_employee");

  return (
    <RelayEmptyState
      className="transcript-empty"
      titleId="transcript-empty-headline"
      title={headline}
      body={t("transcript.landing_body")}
      illustration={(
        <span className="relay-empty-avatar" aria-hidden="true">
          <RelayMark size={ICON.xl} />
        </span>
      )}
      actions={ready && onSuggestion ? (
        <div className="transcript-empty-suggestions">
          {SUGGESTION_KEYS.map((key) => {
            const text = t(`transcript.suggestion_${key}`);
            return (
              <Button
                key={key}
                variant="ghost"
                type="button"
                className="transcript-empty-suggestion"
                onClick={() => onSuggestion(text)}
              >
                <span className="transcript-empty-suggestion-label">
                  {t(`transcript.suggestion_${key}_label`)}
                  <ActionPrompt size={ICON.xs} />
                </span>
                <span className="transcript-empty-suggestion-detail">{text}</span>
              </Button>
            );
          })}
        </div>
      ) : undefined}
      hint={ready ? (
        <span className="transcript-empty-hints">
          <span className="transcript-empty-hint">
            <kbd className="command-kbd">@</kbd>
            {t("transcript.hint_mention")}
          </span>
          <span className="transcript-empty-hint">
            <kbd className="command-kbd">{sendShortcutLabel()}</kbd>
            {t("transcript.hint_send")}
          </span>
        </span>
      ) : undefined}
    />
  );
}
