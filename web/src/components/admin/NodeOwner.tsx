import type { TFunction } from "i18next";
import type { UserRecord } from "../../types";
import { identityMonogram } from "../../lib/identity";
import { handleRestatesName, userHandleOf } from "../../lib/userHandle";
import { ICON, IdentityUser } from "../icons";

/** Whose a computer is, on every fleet card and list row: a monogram mark,
    the user's name, and their @handle. Users carry no profile image, so the
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
  // The handle earns its place only when it adds to the name.
  const showHandle = !handleRestatesName(user.displayName, handle);
  return (
    <span
      className="adm-node-owner"
      data-owner="user"
      title={showHandle ? `${user.displayName} · @${handle}` : `@${handle}`}
    >
      <span className="adm-node-owner-mark" aria-hidden="true">
        {identityMonogram(user.displayName)}
      </span>
      <span className="adm-node-owner-name" translate="no">{user.displayName}</span>
      {showHandle ? (
        <span className="adm-node-owner-handle code" translate="no">@{handle}</span>
      ) : null}
    </span>
  );
}
