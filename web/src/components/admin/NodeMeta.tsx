import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import { ICON, NodeOwnershipIcon } from "../icons";
import { nodeOwnershipProfile } from "./helpers";

/** The quiet second tier of a fleet card or row: what kind of computer it is
    and whose it is, as one line of muted text. These used to be two bordered
    chips, which made the most ordinary facts on the card read as the loudest. */
export function NodeMeta({
  node,
  employeeName,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  employeeName?: string;
  t: TFunction;
}) {
  const ownership = nodeOwnershipProfile(node);
  return (
    <span className="adm-node-meta" title={t(`admin.v2.node_ownership_${ownership}_hint`)}>
      <NodeOwnershipIcon ownership={ownership} size={ICON.sm} className="adm-node-meta-icon" aria-hidden="true" />
      <span className="adm-node-meta-text">
        {t(`admin.v2.node_ownership_${ownership}`)}
        {employeeName ? (
          <>
            <span className="adm-node-meta-sep" aria-hidden="true"> · </span>
            <span translate="no">{employeeName}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}
