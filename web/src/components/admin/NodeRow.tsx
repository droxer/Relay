"use client";

import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord, UserRecord } from "../../types";
import { useNodeDelete } from "../../hooks/useNodeDelete";
import { nodeOwnershipProfile } from "./helpers";
import { NodeActions } from "./NodeActions";
import { NodeOwner } from "./NodeOwner";
import { NodePresence } from "./NodePresence";
import { NodeRuntimeMarks } from "./NodeRuntimeMarks";
import { ICON, NodeOwnershipIcon } from "../icons";
import { ClientOutdatedBadge } from "../computer/ClientOutdatedBadge";
import { HostOsBadge } from "../computer/HostOsBadge";

/* The nodes list is a TanStack table now (see NodesView): a "row" here is one
   component per column, and flexRender mounts each as a real component —
   which is what lets the actions cell keep its own `useNodeDelete` hook.
   The wrapper classNames survive from the div list, but only where they carry
   flex/type chrome; the grid tracks that used to space the row live on the
   table's columns (ColumnChrome in NodesView) now. The offline dimming that
   `.adm-node-row[data-online="false"]` used to drive is ported to the
   `group-data-[online=false]` variants below, keyed off the <tr>'s
   data-online. */

export function NodeIdentityCell({
  node,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  t: TFunction;
}) {
  const nodeName = node.displayName || node.id;
  /* No status pill. The list bands BY status, so the band above this row is
     that pill — said once for the whole group. The presence pill stays:
     online/offline is a fact about the connection, not the lifecycle, and a
     stopped computer can still be reachable. Ownership reads from the leading
     glyph; its name is in the glyph's title rather than a second chip. */
  const ownership = nodeOwnershipProfile(node);

  return (
    <span className="adm-node-row-id">
      <span
        className="adm-node-row-mark group-data-[online=false]:text-(--ink-4)"
        data-ownership={ownership}
        role="img"
        aria-label={t(`admin.v2.node_ownership_${ownership}`)}
        title={t(`admin.v2.node_ownership_${ownership}`)}
      >
        <NodeOwnershipIcon ownership={ownership} size={ICON.md} aria-hidden="true" />
      </span>
      <span className="adm-node-row-identity">
        <span className="adm-node-row-nameline">
          <span className="adm-node-card-name" translate="no" title={nodeName}>
            {nodeName}
          </span>
          <NodePresence node={node} t={t} withLabel />
          <HostOsBadge node={node} />
          <ClientOutdatedBadge node={node} t={t} />
        </span>
        <span className="adm-node-card-handle code" translate="no">{node.id}</span>
      </span>
    </span>
  );
}

export function NodeUserCell({
  node,
  user,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  user?: UserRecord;
  t: TFunction;
}) {
  return (
    <span className="adm-node-row-user group-data-[online=false]:opacity-(--opacity-dormant)">
      <NodeOwner userId={node.userId} user={user} t={t} />
    </span>
  );
}

export function NodeRuntimesCell({ node, t }: { node: ControlPanelDaemonNodeRecord; t: TFunction }) {
  return (
    <span className="adm-node-row-agents group-data-[online=false]:opacity-(--opacity-dormant)">
      <NodeRuntimeMarks node={node} t={t} />
    </span>
  );
}

export function NodeActionsCell({
  node,
  onReveal,
  onRename,
  onManageExecutors,
  onDelete,
  t,
}: {
  node: ControlPanelDaemonNodeRecord;
  onReveal?: (node: ControlPanelDaemonNodeRecord) => void;
  onRename: (node: ControlPanelDaemonNodeRecord) => void;
  onManageExecutors: (node: ControlPanelDaemonNodeRecord) => void;
  onDelete?: (node: ControlPanelDaemonNodeRecord) => Promise<void>;
  t: TFunction;
}) {
  const { deletePending, deleteError, handleDelete } = useNodeDelete(node, onDelete, t);

  return (
    <>
      <span className="adm-node-row-actions">
        <NodeActions
          node={node}
          onReveal={onReveal}
          onRename={onRename}
          onManageExecutors={onManageExecutors}
          onDelete={onDelete}
          deletePending={deletePending}
          onDeleteRequest={() => void handleDelete()}
          t={t}
        />
      </span>
      {deleteError ? (
        <p className="adm-node-row-error" role="alert">{t("admin.v2.action_failed", { message: deleteError })}</p>
      ) : null}
    </>
  );
}
