"use client";

import { useTranslation } from "react-i18next";
import type { TaskStatus } from "../../types";
import { TaskStatusIcon } from "../TaskStatusIcon";

/* One finished, one running, one waiting on a person: the three states a
   visitor will live in, in the order a morning meets them. The agents are
   illustrative names, not records. */
const ROWS: ReadonlyArray<{ status: TaskStatus; key: string }> = [
  { status: "done", key: "done" },
  { status: "running", key: "running" },
  { status: "waiting_for_human", key: "waiting" },
];

/**
 * The waitlist cover's picture of what is being waited for: a small ledger of
 * work that moved while you were away, drawn with the product's own status
 * rings so the first thing a visitor sees is the thing they will use. It is
 * an illustration, so it carries no controls and reads as one figure.
 */
export function WaitlistVignette() {
  const { t } = useTranslation();
  return (
    <figure className="login-vignette">
      <figcaption className="login-vignette-head">{t("waitlist.vignette_label")}</figcaption>
      <ul className="login-vignette-rows">
        {ROWS.map(({ status, key }) => (
          <li className="login-vignette-row" data-status={status} key={key}>
            <TaskStatusIcon status={status} className="login-vignette-icon" />
            <span className="login-vignette-title">{t(`waitlist.vignette_${key}_title`)}</span>
            <span className="login-vignette-meta">{t(`waitlist.vignette_${key}_meta`)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
