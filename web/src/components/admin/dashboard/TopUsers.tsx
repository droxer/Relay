"use client";

import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { UserAvatar } from "../../UserAvatar";
import type { UserRecord } from "../../../types";
import { AVATAR } from "../../icons";
import { userHandleOf } from "../../../lib/userHandle";

interface TopUsersProps {
  users: UserRecord[];
  ranked: Array<{ userId: string; sessionCount: number }>;
  error?: string | null;
  className?: string;
}

export function TopUsers({ users, ranked, error, className }: TopUsersProps) {
  const { t } = useTranslation();
  const titleId = useId();

  const rows = useMemo(() => {
    const userMap = new Map(users.map((e) => [e.id, e] as const));
    return ranked.map((row) => {
      const user = userMap.get(row.userId);
      return {
        id: row.userId,
        // A ranked user can have left the roster; the handle helper keeps
        // their UUID off the screen either way.
        displayName: user?.displayName || userHandleOf(user ?? { id: row.userId }),
        sessionCount: row.sessionCount,
      };
    });
  }, [ranked, users]);
  const leader = Math.max(1, ...rows.map((row) => row.sessionCount));

  return (
    <Card render={<section />} className={className}>
      <CardHeader>
        <CardTitle render={<h2 id={titleId} />}>{t("admin.v2.dash_top_title")}</CardTitle>
      </CardHeader>
      {error ? (
        <CardDescription>{error}</CardDescription>
      ) : rows.length === 0 ? (
        <CardDescription>{t("admin.v2.dash_top_empty")}</CardDescription>
      ) : (
        // The panel caps its height, so the list scrolls; a scroller with no
        // focusable content is unreachable by keyboard without a tab stop.
        <ol className="adm-dash-top-list" tabIndex={0} aria-labelledby={titleId}>
          {rows.map((row, index) => (
            <li key={row.id} className="adm-dash-top-row">
              <span className="adm-dash-top-rank tnum">{index + 1}</span>
              <UserAvatar displayName={row.displayName} running={false} size={AVATAR.md} />
              {/* Name over a share bar scaled to the leader, so the gap between
                  ranks reads at a glance; the count stays the exact figure. */}
              <span className="adm-dash-top-who">
                <span className="adm-dash-top-name">{row.displayName}</span>
                <span className="adm-dash-top-share" aria-hidden="true">
                  <span style={{ width: `${(row.sessionCount / leader) * 100}%` }} />
                </span>
              </span>
              <span className="adm-dash-top-count tnum">{row.sessionCount}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
