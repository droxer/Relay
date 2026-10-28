import { useTranslation } from "react-i18next";
import { RelayMark } from "./RelayMark";
import { ICON } from "./icons";
import { greetingPeriod } from "../lib/welcomeRecap";
import { useMinuteClock } from "../hooks/useMinuteClock";

type TranscriptEmptyProps = {
  selectedUser: string;
  /** First name to greet by; the generic question stands in without one. */
  greetingName?: string;
};

/** The new-thread landing: one line of greeting sitting directly on the
 * composer, which the chat panel centres with it (`.chat-panel--landing`).
 * The input is the whole page — the rail beside it already says where every
 * thread stands, so the landing does not repeat it. */
export function TranscriptEmpty({ selectedUser, greetingName }: TranscriptEmptyProps) {
  const { t } = useTranslation();
  const now = useMinuteClock();
  const ready = Boolean(selectedUser);
  const headline = !ready
    ? t("transcript.ready_no_user")
    : greetingName
      ? t(`transcript.welcome_greeting_${greetingPeriod(new Date(now).getHours())}`, { name: greetingName })
      : t("transcript.ready_for");

  return (
    <section className="transcript-empty" aria-labelledby="transcript-empty-headline">
      <span className="transcript-empty-mark" aria-hidden="true">
        <RelayMark size={ICON.xl} tone="brand" />
      </span>
      <hgroup className="transcript-empty-heading">
        <h2 id="transcript-empty-headline" className="transcript-empty-title">{headline}</h2>
        {ready && greetingName ? <p className="transcript-empty-prompt">{t("transcript.landing_prompt")}</p> : null}
      </hgroup>
    </section>
  );
}
