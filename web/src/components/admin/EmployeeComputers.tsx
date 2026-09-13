"use client";

import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import { isNodeOnline, nodeOwnershipProfile, visualStatus } from "../../lib/adminHelpers";
import { NodePresence } from "./NodePresence";
import {
  ICON,
  nodeOwnershipIcon,
} from "../icons";
import { Badge } from "@/components/ui/badge";

/**
 * The computers assigned to one employee.
 *
 * The employee surfaces answer "who has which machine", so the chip row lists
 * computers, not agents — the activity metrics beside it (`ready/total`) have
 * always counted computers, and pairing them with an agent list made the row
 * read as two unrelated tallies. Agents live on a computer, one level down;
 * they belong to the Nodes view and the Agents page.
 *
 * Chip anatomy matches the node card: presence dot (liveness) + ownership mark
 * (cloud / laptop / pending) + name. Static by design — this is a readout, and
 * a machine's actions live on its own card.
 */
export function EmployeeComputers({
  nodes,
  t,
}: {
  nodes: ControlPanelDaemonNodeRecord[];
  t: TFunction;
}) {
  if (nodes.length === 0) {
    return <span className="adm-emp-no-nodes">{t("admin.v2.no_computers_for_employee")}</span>;
  }

  return (
    <>
      {nodes.map((node) => {
        const ownership = nodeOwnershipProfile(node);
        const OwnershipMark = nodeOwnershipIcon(ownership);
        const status = visualStatus(node);
        const title = [
          node.displayName || node.id,
          t(`admin.v2.node_ownership_${ownership}`),
          t(`status.${status}`, { defaultValue: status }),
        ].join(" · ");
        return (
          <Badge
            key={node.id}
            className="adm-node-chip adm-computer-chip"
            data-ownership={ownership}
            data-online={isNodeOnline(node) ? "true" : "false"}
            title={title}
          >
            <NodePresence node={node} t={t} />
            <OwnershipMark size={ICON.sm} className="adm-node-chip-mark" aria-hidden="true" />
            <span className="adm-computer-chip-name code" translate="no">
              {node.displayName || node.id}
            </span>
          </Badge>
        );
      })}
    </>
  );
}
