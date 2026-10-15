"use client";

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { WaitlistEntry, WaitlistInviteResult } from "../../../types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TonePill } from "../../StatusPill";
import { formatRelativeTime } from "../../../lib/adminHelpers";
import { deliveryLabelKey, deliveryTone, inviteState } from "../../../lib/waitlist";
import { WaitlistActions } from "./WaitlistActions";

/** Company and role on one line — whichever the person gave. */
function affiliation(entry: WaitlistEntry): string {
  return [entry.role, entry.company].filter(Boolean).join(" · ");
}

/** The fact each band is read for: when they asked, while waiting; whether
    the link still works and whether the mail went out, once invited. */
function StatusDetail({ entry, t }: { entry: WaitlistEntry; t: TFunction }) {
  const invite = inviteState(entry);
  return (
    <div className="adm-waitlist-detail">
      {invite === "expired" ? (
        <TonePill tone="bad" label={t("admin.waitlist.invite_expired")} />
      ) : invite === "live" && entry.inviteExpiresAt ? (
        <span className="adm-waitlist-when">
          {t("admin.waitlist.invite_expires", { date: new Date(entry.inviteExpiresAt).toLocaleDateString() })}
        </span>
      ) : (
        <span className="adm-waitlist-when">
          {t("admin.waitlist.requested", { when: formatRelativeTime(entry.createdAt, t) })}
        </span>
      )}
      {entry.lastDeliveryStatus && entry.status === "invited" ? (
        <TonePill
          tone={deliveryTone(entry.lastDeliveryStatus)}
          label={t(deliveryLabelKey(entry.lastDeliveryStatus))}
          title={entry.lastDeliveryError ?? undefined}
        />
      ) : null}
    </div>
  );
}

/**
 * One status band's entries as a table, with its own header like the other
 * admin lists. Rows arrive already filtered, ordered oldest first, and paged
 * by the server, so this only lays them out. There is no per-row status: the
 * band above already says it.
 */
export function WaitlistGroupTable({
  label,
  entries,
  onInvited,
}: {
  label: string;
  entries: WaitlistEntry[];
  onInvited: (results: WaitlistInviteResult[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <Table data-density="compact" aria-label={label} className="adm-waitlist-table">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("admin.waitlist.col_person")}</TableHead>
          <TableHead>{t("admin.waitlist.col_use_case")}</TableHead>
          <TableHead className="adm-waitlist-col-detail">{t("admin.waitlist.col_detail")}</TableHead>
          <TableHead className="adm-emp-col-actions text-right">{t("admin.v2.col_actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id} data-waitlist-entry={entry.id}>
            <TableCell>
              <p className="adm-emp-name" translate="no">{entry.name || entry.email}</p>
              <p className="adm-emp-meta">
                {entry.name ? <span className="code" translate="no">{entry.email}</span> : null}
                {affiliation(entry) ? <span>{affiliation(entry)}</span> : null}
                {entry.source ? <span>{t("admin.waitlist.via", { source: entry.source })}</span> : null}
              </p>
            </TableCell>
            <TableCell>
              <p className="adm-waitlist-use-case" title={entry.useCase ?? undefined}>
                {entry.useCase || <span className="ink-dim">{t("admin.waitlist.no_use_case")}</span>}
              </p>
              {entry.adminNote ? (
                <p className="adm-emp-meta" title={entry.adminNote}>
                  {t("admin.waitlist.note_label", { note: entry.adminNote })}
                </p>
              ) : null}
            </TableCell>
            <TableCell className="adm-waitlist-col-detail">
              <StatusDetail entry={entry} t={t} />
            </TableCell>
            <TableCell className="adm-emp-col-actions text-right">
              <WaitlistActions entry={entry} onInvited={onInvited} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
