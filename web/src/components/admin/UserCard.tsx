"use client";

import { userHandleOf } from "../../lib/userHandle";
import { identityMonogram } from "../../lib/identity";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import {
  ActionEdit,
  AdminDelete,
  ICON,
} from "../icons";
import {
  userSummaryStatus,
  type UserNodeSummary,
} from "./helpers";
import { UserComputers } from "./UserComputers";
import { UserLimits } from "./UserLimits";
import { TonePill } from "../StatusPill";

interface UserCardProps {
  member: UserNodeSummary;
  highlight: boolean;
  onDelete?: (userId: string) => void;
  onEdit?: (userId: string) => void;
  deletePending: boolean;
  t: TFunction;
}

export function UserCard({
  member,
  highlight,
  onDelete,
  onEdit,
  deletePending,
  t,
}: UserCardProps) {
  const { tone, key } = userSummaryStatus(member);
  return (
    <article
      className={`adm-node-card adm-emp-card tone-${tone}${highlight ? " is-pulse" : ""}`}
      data-user={member.id}
    >
      <header className="adm-node-card-head">
        {/* Initials, the way the dashboard's top-users list draws the same
            person — one generic people glyph on every card told them apart by
            nothing. */}
        <span className="adm-node-avatar adm-emp-avatar" aria-hidden="true" translate="no">
          {identityMonogram(member.displayName)}
        </span>
        <div className="adm-node-card-identity">
          <span className="adm-node-card-name" translate="no" title={member.displayName}>{member.displayName}</span>
          {/* Handle and department share one line: two short facts stacked
              as two lines made the header the tallest part of the card. */}
          <span className="adm-emp-card-sub">
            <span className="adm-node-card-handle code" translate="no">@{userHandleOf(member)}</span>
            {member.departmentName ? (
              <span className="adm-emp-card-dept">{member.departmentName}</span>
            ) : null}
          </span>
          {/* "Ready" is the default healthy state — the good tone on the card
              already carries it; only running / idle / no-nodes get named.
              Same place and drawing as a computer card's status: under the
              name, dot + word, no tinted slab. */}
          {key !== "ready" ? (
            <span className="adm-node-card-state">
              <TonePill
                className="adm-status-plain"
                tone={tone}
                label={t(`admin.v2.emp_state_${key}`, { defaultValue: key })}
                live={tone === "info"}
              />
            </span>
          ) : null}
        </div>
        {/* Actions sit beside the name so the footer can give the limits its
            full width; at a card's width the two did not fit one line. */}
        {onDelete || onEdit ? (
          <div className="adm-node-card-actions">
            {onEdit ? (
              <Button
                variant="icon"
                size="icon-dense"
                tinted
                type="button"
                className="adm-node-card-icon-btn"
                onClick={() => onEdit(member.id)}
                tooltip={t("admin.v2.edit_user_action")}
              >
                <ActionEdit size={ICON.sm} aria-hidden="true" />
              </Button>
            ) : null}
            {onDelete ? (
            <Button
              variant="icon"
              size="icon-dense"
              tinted
              type="button"
              danger
              className="adm-node-card-icon-btn"
              onClick={() => onDelete(member.id)}
              disabled={deletePending}
              tooltip={t("admin.v2.delete_user_action")}
            >
              <AdminDelete size={ICON.sm} aria-hidden="true" />
            </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="adm-node-card-body">
        <div className="adm-agents adm-emp-nodes">
          {/* Every computer the user has, cloud and local alike — the same
              set the list row shows and the READY x/y footer below counts.
              Filtering to local machines made a card with only a cloud
              computer say "No computer assigned." beside READY 0/1. */}
          <UserComputers nodes={member.nodes} t={t} />
        </div>
      </div>

      <footer className="adm-node-card-foot adm-emp-card-foot">
        {/* The two limits an admin sets on this user. Running is the state
            pill above and readiness is each computer's dot, so neither is
            counted again here. */}
        <UserLimits member={member} t={t} />
      </footer>
    </article>
  );
}
