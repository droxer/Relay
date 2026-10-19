import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord, UserRecord } from "../../types";
import { ICON, NodeOwnershipIcon } from "../icons";
import { nodeOwnershipProfile } from "./helpers";
import { NodeOwner } from "./NodeOwner";

/** The second tier of a fleet card: whose computer it is, then what kind.
    The owner leads — it is the fact an admin scans a fleet for — and the kind
    stays a quiet trailing label, not a chip. */
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
      <span className="adm-node-meta-kind" title={t(`admin.v2.node_ownership_${ownership}_hint`)}>
        <NodeOwnershipIcon ownership={ownership} size={ICON.sm} className="adm-node-meta-icon" aria-hidden="true" />
        <span className="adm-node-meta-text">{t(`admin.v2.node_ownership_${ownership}`)}</span>
      </span>
    </div>
  );
}
