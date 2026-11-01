"use client";

import { useTranslation } from "react-i18next";
import type { HomeSetup } from "../../lib/homeSetup";
import { HomeLink } from "./HomePanels";

const NAMED_LIMIT = 2;

type T = (key: string, options?: Record<string, unknown>) => string;

/** "a, b and 3 more": a short list never pushes the line past one row. */
function namedList(names: readonly string[], t: T): string {
  const shown = names.slice(0, NAMED_LIMIT).join(", ");
  const rest = names.length - NAMED_LIMIT;
  return rest > 0 ? t("home.setup.and_more", { names: shown, count: rest }) : shown;
}

/** Your setup: computers online and agents ready, quiet while everything is
 *  fine and naming what is not. Only an exception carries colour; a dark
 *  computer holding queued work already has its own row in Up next. */
export function HomeSetupPanel({ setup, computersHref, agentsHref, onOpenComputers, onOpenAgents }: {
  setup: HomeSetup;
  computersHref: string;
  agentsHref: string;
  onOpenComputers: () => void;
  onOpenAgents: () => void;
}) {
  const { t } = useTranslation();
  const { computers, agents } = setup;
  const computerNote = computers.total === 0
    ? { tone: "warn", text: t("home.setup.no_computers") }
    : computers.offline.length ? { tone: "err", text: t("home.setup.offline", { names: namedList(computers.offline, t) }) } : null;
  const agentNote = agents.total === 0
    ? { tone: "warn", text: t("home.setup.no_agents") }
    : agents.unavailable.length ? { tone: "err", text: t("home.setup.unavailable", { names: namedList(agents.unavailable, t) }) } : null;
  const cells = [
    {
      key: "computers",
      href: computersHref,
      onOpen: onOpenComputers,
      ready: computers.online,
      total: computers.total,
      label: t("home.setup.computers_label"),
      spoken: t("home.setup.computers_spoken", { ready: computers.online, total: computers.total }),
      note: computerNote,
    },
    {
      key: "agents",
      href: agentsHref,
      onOpen: onOpenAgents,
      ready: agents.ready,
      total: agents.total,
      label: t("home.setup.agents_label"),
      spoken: t("home.setup.agents_spoken", { ready: agents.ready, total: agents.total }),
      note: agentNote,
    },
  ];
  return (
    <section className="home-section" aria-labelledby="home-setup-title">
      <header className="home-section-header">
        <h2 id="home-setup-title" className="home-section-title">{t("home.setup.title")}</h2>
      </header>
      <ul className="home-panel home-setup">
        {cells.map((cell) => (
          <li key={cell.key} data-cell={cell.key}>
            <HomeLink className="home-count home-setup-cell" href={cell.href} onOpen={cell.onOpen}>
              <span className="sr-only">{cell.spoken}</span>
              <span className="home-count-number tnum" aria-hidden="true">
                {cell.ready}<span className="home-setup-total">/{cell.total}</span>
              </span>
              <span className="home-count-label" aria-hidden="true">{cell.label}</span>
              {cell.note ? <span className="home-setup-note" data-tone={cell.note.tone}>{cell.note.text}</span> : null}
            </HomeLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
