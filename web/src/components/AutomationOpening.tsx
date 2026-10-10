import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavRoutine, ICON } from "./icons";
import { MarkdownContent } from "./LazyMarkdown";
import {
  listedOpeningEvents,
  openingTriggerLabel,
  type AutomationOpening as Opening,
  type OpeningEvent,
} from "../lib/automationOpening";

type AutomationOpeningProps = {
  opening: Opening;
  /** The transcript's own timestamp element, so the card keeps the rail's
      time column like every other turn. */
  time: ReactNode;
};

/**
 * The first turn of an automation run. Nobody typed it — the automation
 * fired — so it reads as a record card under the automation's mark rather
 * than a bubble beside the user's avatar, and the English trigger block the
 * agent receives renders here in the reader's language.
 */
export function AutomationOpening({ opening, time }: AutomationOpeningProps) {
  const { t } = useTranslation();
  const events = listedOpeningEvents(opening.trigger);
  const dropped = opening.trigger?.dropped ?? 0;
  return (
    <article className="msg msg-automation" aria-label={t("automation.opening.label", { title: opening.title })}>
      <span className="rail-node rail-node-automation" aria-hidden="true">
        <NavRoutine size={ICON.sm} />
      </span>
      <div className="turn-body automation-opening">
        <header className="automation-opening-head">
          <span className="automation-opening-kicker">{t("automation.opening.kicker")}</span>
          <span className="automation-opening-trigger">{openingTriggerLabel(opening.trigger, t)}</span>
        </header>
        <h3 className="automation-opening-title">{opening.title}</h3>
        {opening.body ? (
          <div className="automation-opening-brief md-body agent-prose">
            <MarkdownContent text={opening.body} />
          </div>
        ) : null}
        {events.length > 0 || dropped > 0 ? (
          <section className="automation-opening-events" aria-label={t("automation.opening.events")}>
            <h4 className="automation-opening-events-head">{t("automation.opening.events")}</h4>
            <ul>
              {events.map((event, index) => (
                <li key={index} className="automation-opening-event" data-kind={event.kind}>
                  <OpeningEventLine event={event} />
                </li>
              ))}
            </ul>
            {dropped > 0 ? (
              <p className="automation-opening-more">{t("automation.opening.not_listed", { count: dropped })}</p>
            ) : null}
          </section>
        ) : null}
      </div>
      {time}
    </article>
  );
}

function OpeningEventLine({ event }: { event: OpeningEvent }) {
  const { t } = useTranslation();
  switch (event.kind) {
    case "status_changed":
      return (
        <>
          <span className="automation-opening-subject">{event.title}</span>
          <span className="automation-opening-detail">
            {t(`backlog.statuses.${event.from}`)} → {t(`backlog.statuses.${event.to}`)}
          </span>
        </>
      );
    case "task_created":
      return (
        <>
          <span className="automation-opening-subject">{event.title}</span>
          <span className="automation-opening-detail">{t("automation.ledger.task_created")}</span>
        </>
      );
    case "run":
      return (
        <>
          <span className="automation-opening-subject">{event.title ?? t("automation.opening.thread")}</span>
          <span className="automation-opening-detail" data-outcome={event.outcome}>
            {t(`automation.ledger.run_${event.outcome}`)}
          </span>
          {event.error ? <span className="automation-opening-error">{event.error}</span> : null}
        </>
      );
    case "webhook":
      return (
        <>
          <span className="automation-opening-subject">{t("automation.opening.webhook_payload")}</span>
          <pre className="automation-opening-payload"><code>{prettyPayload(event.payload)}</code></pre>
        </>
      );
    case "other":
      return <span className="automation-opening-subject">{event.text}</span>;
    default:
      return null;
  }
}

/** Indented when the payload parses; a truncated one stays as sent. */
function prettyPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}
