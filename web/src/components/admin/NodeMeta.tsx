import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord, UserRecord } from "../../types";
import { ICON, NodeOwnershipIcon } from "../icons";
import { nodeOwnershipProfile } from "./helpers";
import { NodeOwner } from "./NodeOwner";

/** The second tier of a fleet card: whose computer it is, then what kind.
    The owner leads — it is the fact an admin scans a fleet for — and the kind
    is a trailing glyph alone; its name lives in the glyph's label and title. */
export function NodeMeta({
  node,
  user,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  user?: UserRecord;
  t: TFunction;
}) {
  const ownership = nodeOwnershipProfile(node);
  return (
    <div className="adm-node-meta">
      <NodeOwner userId={node.userId} user={user} t={t} />
      <span
        className="adm-node-meta-kind"
        role="img"
        aria-label={t(`admin.v2.node_ownership_${ownership}`)}
        title={t(`admin.v2.node_ownership_${ownership}_hint`)}
      >
        <NodeOwnershipIcon ownership={ownership} size={ICON.sm} className="adm-node-meta-icon" aria-hidden="true" />
      </span>
    </div>
  );
}
