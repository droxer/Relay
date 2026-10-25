import type { TFunction } from "i18next";
import type { UserRecord } from "../../types";
import { identityMonogram } from "../../lib/identity";
import { handleRestatesName, userHandleOf } from "../../lib/userHandle";
import { ICON, IdentityUser } from "../icons";

/** Whose a computer is, on every fleet card and list row: a monogram mark
    and one label — the user's name, or their @handle when there is no name
    worth showing. Printing both read as two owners, so the handle rides the
    tooltip instead. Users carry no profile image, so the
    mark is initials — never the id, which is a UUID. A computer nobody holds
    reads "Unassigned" behind a hollow mark, so the column never goes blank;
    an owner id the console has no record for says so instead of printing it. */
export function NodeOwner({
  userId,
  user,
  t,
}: {
  userId?: string;
  user?: UserRecord;
  t: TFunction;
}) {
  if (!userId) {
    return (
      <span className="adm-node-owner" data-owner="none">
        <span className="adm-node-owner-mark" aria-hidden="true">
          <IdentityUser size={ICON.xs} />
        </span>
        <span className="adm-node-owner-name">{t("admin.v2.node_owner_unassigned")}</span>
      </span>
    );
  }
  if (!user) {
    return (
      <span className="adm-node-owner" data-owner="unknown">
        <span className="adm-node-owner-mark" aria-hidden="true">?</span>
        <span className="adm-node-owner-name">{t("admin.v2.node_owner_unknown")}</span>
      </span>
    );
  }
  const handle = userHandleOf(user);
  const name = user.displayName?.trim();
  // One label per owner: the name, unless it is missing or only restates
  // the handle — then the @handle is the label.
  const label = name && !handleRestatesName(name, handle) ? name : `@${handle}`;
  return (
    <span
      className="adm-node-owner"
      data-owner="user"
      title={label === name ? `${name} · @${handle}` : label}
    >
      <span className="adm-node-owner-mark" aria-hidden="true">
        {identityMonogram(name || handle)}
      </span>
      <span className="adm-node-owner-name" translate="no">{label}</span>
    </span>
  );
}
