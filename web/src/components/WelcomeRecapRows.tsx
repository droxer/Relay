import { useTranslation } from "react-i18next";
import { StateMark } from "./StateMark";
import { threadLabel, type ThreadItem } from "../lib/threads";
import { formatThreadStamp } from "../lib/threadStamp";
import type { WelcomeRow } from "../lib/welcomeRecap";

type WelcomeRecapRowsProps = {
  rows: readonly WelcomeRow[];
  now: number;
  agentNameFor: (item: ThreadItem) => string | undefined;
  onOpenThread: (sessionId: string) => void;
};

/** A finished thread's check draws itself once on arrival (empty-state.css);
 * a done thing settles rather than pulses. */
function DoneCheck() {
  return (
    <svg className="welcome-row-check" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M3 8.5 L6.5 12 L13 4.5" pathLength="1" />
    </svg>
  );
}

function RowMark({ kind }: { kind: WelcomeRow["kind"] }) {
  if (kind === "needs_you") return <StateMark tone="warn" />;
  if (kind === "running") return <StateMark tone="live" />;
  return <DoneCheck />;
}

/** The welcome-back rows: title first, then who is doing what in plain words.
 * The one thread that needs the person carries the only action word. */
export function WelcomeRecapRows({ rows, now, agentNameFor, onOpenThread }: WelcomeRecapRowsProps) {
  const { t, i18n } = useTranslation();
  return (
    <ul className="welcome-recap" aria-label={t("transcript.welcome_recap_label")}>
      {rows.map(({ kind, item }) => {
        const agent = agentNameFor(item);
        const phrase = agent
          ? t(`transcript.welcome_${kind}`, { agent })
          : t(`transcript.welcome_${kind}_anon`);
        return (
          <li key={item.session.id}>
            <button
              type="button"
              className="welcome-row"
              data-kind={kind}
              onClick={() => onOpenThread(item.session.id)}
            >
              <span className="welcome-row-mark"><RowMark kind={kind} /></span>
              <span className="welcome-row-text">
                <span className="welcome-row-title">{threadLabel(item.session)}</span>
                <span className="welcome-row-phrase">{phrase}</span>
              </span>
              {kind === "needs_you" ? (
                <span className="welcome-row-go">{t("transcript.welcome_answer")}</span>
              ) : (
                <span className="welcome-row-stamp tnum">
                  {formatThreadStamp(item.session.updatedAt, i18n.language, now)}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
