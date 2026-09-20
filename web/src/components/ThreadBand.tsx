"use client";

import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../lib/adminHelpers";
import { pathForAppState } from "../lib/appRoute";
import { computerId as stableComputerId } from "../lib/createAgent";
import { threadBandFacts } from "../lib/threadBand";
import { useProjectLookup } from "../hooks/useProjectLookup";
import type { DaemonNodeMonitorRecord, RelaySession } from "../types";
import { RecordBand, type RecordFact } from "./workspace/RecordBand";

/**
 * A thread's facts band.
 *
 * Every other record surface — agent, team, task, project — prints one under
 * its header, and the thread was the one record whose coordinates lived
 * nowhere: the space panel browsed a project's workspace while the thread
 * itself never named the project or offered a way back to it.
 *
 * The same `RecordBand` the other surfaces use, so a thread reads as one of
 * them rather than as its own idiom.
 */
export function ThreadBand({
  session,
  agentName,
  computers,
  onOpenProject,
}: {
  session: RelaySession;
  /** The agent answering in this thread, already resolved for the composer. */
  agentName?: string;
  computers: DaemonNodeMonitorRecord[];
  onOpenProject: (projectId: string) => void;
}) {
  const { t } = useTranslation();
  const projectOf = useProjectLookup();
  const computer = computers.find((node) => stableComputerId(node) === session.computerId);
  const facts = threadBandFacts(session, {
    projectName: projectOf(session.projectId)?.name,
    agentName,
    computerName: computer?.displayName?.trim() || session.computerId?.replace(/^device:[^:]+:/, ""),
  }).map<RecordFact>((fact) => {
    if (fact.key === "project") {
      const href = pathForAppState({
        route: "projects",
        mobileView: "chat",
        sessionId: null,
        projectId: fact.projectId,
      });
      return {
        key: fact.key,
        label: t("thread.band_project"),
        title: fact.projectId,
        value: (
          <a
            className="thread-band-link"
            href={href}
            onClick={(event) => {
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onOpenProject(fact.projectId);
            }}
          >
            {fact.name}
          </a>
        ),
      };
    }
    if (fact.key === "agent") return { key: fact.key, label: t("thread.band_agent"), value: fact.name };
    if (fact.key === "computer") {
      return { key: fact.key, label: t("thread.band_computer"), value: fact.name, title: fact.id };
    }
    return { key: fact.key, label: t("thread.band_updated"), value: formatRelativeTime(fact.iso, t) };
  });

  return <RecordBand facts={facts} label={t("thread.band_label")} />;
}
