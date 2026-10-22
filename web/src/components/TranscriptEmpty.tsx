import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RelayEmptyState } from "./RelayEmptyState";
import { RelayMark } from "./RelayMark";
import { ActionPrompt, ICON } from "./icons";
import { WelcomeRecapRows } from "./WelcomeRecapRows";
import { sendShortcutLabel } from "../lib/sendShortcut";
import { buildWelcomeRecap, greetingPeriod, type WelcomeRecap } from "../lib/welcomeRecap";
import type { ThreadItem } from "../lib/threads";
import type { RelayTaskListItem } from "../types";
import { useMinuteClock } from "../hooks/useMinuteClock";
import { Button } from "@/components/ui/button";

type TranscriptEmptyProps = {
  selectedUser: string;
  /** A starter chip drops its prompt into the composer and focuses it. */
  onSuggestion?: (text: string) => void;
  /** First name to greet by; the generic question stands in without one. */
  greetingName?: string;
  /** The person's threads and tasks, read for where things stand. With
   *  nothing recent to report, the landing offers starters instead. */
  threads?: readonly ThreadItem[];
  tasks?: readonly RelayTaskListItem[];
  agentNameFor?: (item: ThreadItem) => string | undefined;
  onOpenThread?: (sessionId: string) => void;
};

const SUGGESTION_KEYS = ["plan", "review", "orient"] as const;

/** The handoff, drawn: the path already walked is solid, the path ahead is
 * dotted and drifts forward, and the mark rides the crest between them. */
function HandoffScene() {
  return (
    <span className="handoff-scene" aria-hidden="true">
      <svg className="handoff-scene-path" viewBox="0 0 240 88" focusable="false">
        <line className="handoff-scene-ground" x1="8" y1="70" x2="232" y2="70" />
        <path className="handoff-scene-walked" d="M20 70 C 60 70, 70 30, 104 30" pathLength="1" />
        <path className="handoff-scene-ahead" d="M136 30 C 170 30, 180 70, 220 70" />
        <circle className="handoff-scene-start" cx="20" cy="70" r="3" />
        <circle className="handoff-scene-end" cx="220" cy="70" r="3" />
      </svg>
      <span className="handoff-scene-mark">
        <RelayMark size={ICON.xl} tone="brand" />
      </span>
    </span>
  );
}

function Starters({ onSuggestion }: { onSuggestion: (text: string) => void }) {
  const { t } = useTranslation();
  return (
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
  );
}

function WeekLine({ week }: { week: WelcomeRecap["week"] }) {
  const { t } = useTranslation();
  if (week.finished === 0) return null;
  return (
    <p className="welcome-week">
      <span>{t("transcript.welcome_week_finished", { count: week.finished })}</span>
      {week.agents > 0 ? <span>{t("transcript.welcome_week_agents", { count: week.agents })}</span> : null}
    </p>
  );
}

export function TranscriptEmpty({
  selectedUser,
  onSuggestion,
  greetingName,
  threads,
  tasks,
  agentNameFor = () => undefined,
  onOpenThread,
}: TranscriptEmptyProps) {
  const { t } = useTranslation();
  const now = useMinuteClock();
  const recap = useMemo(
    () => (threads ? buildWelcomeRecap(threads, tasks ?? [], now) : undefined),
    [threads, tasks, now],
  );
  const ready = Boolean(selectedUser);
  const greeting = ready && greetingName
    ? t(`transcript.welcome_greeting_${greetingPeriod(new Date(now).getHours())}`, { name: greetingName })
    : undefined;
  const headline = greeting ?? (ready ? t("transcript.ready_for") : t("transcript.ready_no_user"));
  const showRecap = ready && Boolean(onOpenThread) && (recap?.rows.length ?? 0) > 0;
  const body = !showRecap
    ? t("transcript.landing_body")
    : (recap?.needsYouTotal ?? 0) > 0 ? t("transcript.welcome_body_needs_you") : t("transcript.welcome_body_calm");

  const starters = ready && onSuggestion && !showRecap ? <Starters onSuggestion={onSuggestion} /> : null;
  const rows = showRecap && recap && onOpenThread ? (
    <WelcomeRecapRows rows={recap.rows} now={now} agentNameFor={agentNameFor} onOpenThread={onOpenThread} />
  ) : null;
  const week = ready && recap && recap.week.finished > 0 ? <WeekLine week={recap.week} /> : null;
  const actions = rows || starters || week ? <>{rows}{starters}{week}</> : undefined;

  return (
    <RelayEmptyState
      className="transcript-empty"
      titleId="transcript-empty-headline"
      title={headline}
      body={body}
      illustration={<HandoffScene />}
      actions={actions}
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
