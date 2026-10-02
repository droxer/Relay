"use client";

import type { TFunction } from "i18next";
import type { ControlPanelDaemonNodeRecord } from "../../types";
import { ICON, NodeOwnershipIcon } from "../icons";
import {
  nodeOwnershipProfile,
  nodeLocalityKinds,
  nodeSandboxProfile,
  type StoredNodeTokenMap,
} from "./helpers";

interface NodeProfileBadgesProps {
  node: ControlPanelDaemonNodeRecord;
  storedTokens: StoredNodeTokenMap;
  colocated: boolean;
  t: TFunction;
  compact?: boolean;
  /** Node cards show ownership only; runtime isolation belongs in drawers. */
  card?: boolean;
  /** Drop the sandbox badge — node rows show ownership only, matching cards. */
  hideSandbox?: boolean;
  /** Drop the "This host" locality — redundant on the node card, where the
   *  status pill already conveys liveness. */
  hideThisHost?: boolean;
  /** Drop the "Saved here" locality on the node card; credential state is
   *  noise in the node overview. */
  hideSavedHere?: boolean;
}

export function NodeProfileBadges({ node, storedTokens, colocated, t, compact = false, card = false, hideSandbox = false, hideThisHost = false, hideSavedHere = false }: NodeProfileBadgesProps) {
  const ownership = nodeOwnershipProfile(node);
  const sandbox = nodeSandboxProfile(node);
  const localities = nodeLocalityKinds(node, { storedTokens, colocated })
    .filter((locality) => !(hideThisHost && locality === "this_host"))
    .filter((locality) => !(hideSavedHere && locality === "saved_here"));
  const ownershipLabel = t(`admin.v2.node_ownership_${ownership}`);
  const ownershipHint = t(`admin.v2.node_ownership_${ownership}_hint`);
  const sandboxLabel = t(`admin.v2.node_sandbox_${sandbox}`);
  const sandboxHint = t(`admin.v2.node_sandbox_${sandbox}_hint`);
  const localityText = localities
    .map((locality) => t(`admin.v2.node_locality_${locality}`))
    .join(" · ");
  const localityHint = localities
    .map((locality) => t(`admin.v2.node_locality_${locality}_hint`))
    .join(" · ");
  const showSandbox = !card && !hideSandbox;

  return (
    <div
      className={`adm-node-profile${compact ? " is-compact" : ""}`}
      role="group"
      aria-label={!showSandbox
        ? ownershipLabel
        : t("admin.v2.node_profile_label", {
            ownership: ownershipLabel,
            sandbox: sandboxLabel,
          })}
    >
      <span
        className="adm-node-profile-kind"
        data-kind={ownership}
        title={ownershipHint}
        translate="no"
      >
        <NodeOwnershipIcon ownership={ownership} size={ICON.sm} className="adm-node-profile-icon" aria-hidden="true" />
        {ownershipLabel}
      </span>
      {showSandbox ? (
        <>
          <span className="adm-node-profile-sep" aria-hidden="true">·</span>
          <span
            className="adm-node-profile-sandbox code"
            data-sandbox={sandbox}
            title={sandboxHint}
          >
            {sandboxLabel}
          </span>
        </>
      ) : null}
      {!card && localityText ? (
        <>
          <span className="adm-node-profile-sep" aria-hidden="true">·</span>
          <span className="adm-node-profile-locality code" title={localityHint} translate="no">
            {localityText}
          </span>
        </>
      ) : null}
    </div>
  );
}
