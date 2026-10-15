"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionAdd,
  ActionApprove,
  AdminInbox,
  ICON,
} from "../icons";
import { assignControlPanelDaemonNode, createControlPanelDaemonNode, createManagedNode } from "../../api";
import type {
  AssignControlPanelDaemonNodeResponse,
  ControlPanelDaemonNodeRecord,
  UserRecord,
} from "../../types";
import type { AddNodeDrawerSuccess } from "./AddNodeDrawer";
import { userHandleOf } from "../../lib/userHandle";
import { Drawer } from "@/components/ui/Drawer";
import { RunModeField, type RunLocation } from "./RunModeField";
import { initialsOf, statusTone, visualStatus } from "./helpers";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { NodeProfileBadges } from "./NodeProfileBadges";
import { NodePresence } from "./NodePresence";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import { useOnOpen } from "@/hooks/useKeyChange";

/** Sentinel value for the "create a new node instead" choice, which shares
 *  the node picker's radio group but has no node id of its own. */
const NEW_NODE_VALUE = "__new__";

interface AssignNodeDrawerProps {
  open: boolean;
  onClose: () => void;
  users: UserRecord[];
  unassignedNodes: ControlPanelDaemonNodeRecord[];
  defaultUserId?: string;
  onAssignSuccess: (result: AssignControlPanelDaemonNodeResponse) => void;
  onCreateNodeSuccess: (outcome: AddNodeDrawerSuccess) => void;
}

export function AssignNodeDrawer({
  open,
  onClose,
  users,
  unassignedNodes,
  defaultUserId,
  onAssignSuccess,
  onCreateNodeSuccess,
}: AssignNodeDrawerProps) {
  const { t } = useTranslation();
  const userLabelId = useId();
  const [userId, setUserId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [createNew, setCreateNew] = useState(false);
  const [nodeLocation, setNodeLocation] = useState<RunLocation>("managed");
  const [displayName, setDisplayName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    userId?: string;
    nodeId?: string;
    workspacePath?: string;
  }>({});
  const [isBusy, setIsBusy] = useState(false);
  const userTriggerRef = useRef<HTMLButtonElement>(null);
  const nodeListRef = useRef<HTMLUListElement>(null);
  const workspacePathRef = useRef<HTMLInputElement>(null);

  useOnOpen(open, () => {
    setUserId(defaultUserId ?? "");
    setNodeId("");
    setCreateNew(false);
    setNodeLocation("managed");
    setDisplayName("");
    setWorkspacePath("");
    setError(null);
    setFieldErrors({});
    setIsBusy(false);
  }, defaultUserId ?? "");

  function clearFieldError(field: "userId" | "nodeId" | "workspacePath") {
    setFieldErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  const userLocked = Boolean(defaultUserId);
  const selectedUser = useMemo(
    () => users.find((e) => e.id === userId) ?? null,
    [users, userId],
  );
  const hasNodes = unassignedNodes.length > 0;
  // With no unassigned nodes, creating one is the only path — force it.
  const creatingNode = createNew || !hasNodes;
  const isManaged = nodeLocation === "managed";
  // Nothing here can be assigned to nobody, so an empty directory blocks the
  // whole form rather than failing validation against a picker that is not
  // rendered.
  const blockedNoUsers = users.length === 0 && !userLocked;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blockedNoUsers) return;
    const nextUserId = userId.trim().replace(/^@/, "");
    const nextFieldErrors: typeof fieldErrors = {};
    if (!nextUserId) nextFieldErrors.userId = t("admin.user_required");
    if (!creatingNode && !nodeId) nextFieldErrors.nodeId = t("admin.node_required");
    if (creatingNode && !isManaged && !workspacePath.trim()) nextFieldErrors.workspacePath = t("admin.v2.workspace_path_required");
    setFieldErrors(nextFieldErrors);
    const firstInvalid = nextFieldErrors.userId
      ? userTriggerRef
      : nextFieldErrors.nodeId
        ? nodeListRef
        : nextFieldErrors.workspacePath
          ? workspacePathRef
          : null;
    if (firstInvalid) {
      firstInvalid.current?.focus();
      return;
    }

    setIsBusy(true);
    setError(null);
    try {
      if (creatingNode) {
        if (isManaged) {
          const result = await createManagedNode({
            userId: nextUserId,
            displayName: displayName.trim() || undefined,
            sandboxMode: "boxlite",
          });
          onCreateNodeSuccess({ kind: "managed", result });
        } else {
          // Direct-run, not isolated — see AddNodeDrawer: a local computer
          // runs agents as host processes, so the isolated runtime would hand
          // back a start command for a VM the device cannot boot.
          const result = await createControlPanelDaemonNode({
            userId: nextUserId,
            displayName: displayName.trim() || undefined,
            workspacePath: workspacePath.trim(),
            sandboxMode: "none",
            nodeLocation: "user-device",
          });
          onCreateNodeSuccess({ kind: "manual", result });
        }
      } else {
        const result = await assignControlPanelDaemonNode({
          userId: nextUserId,
          nodeId,
        });
        onAssignSuccess(result);
      }
    } catch (err) {
      setError(
        t(creatingNode ? "admin.v2.create_node_error" : "admin.v2.assign_error", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setIsBusy(false);
    }
  }

  const displayHandle = selectedUser
    ? `@${userHandleOf(selectedUser)}`
    : userId
      ? `@${userId.replace(/^@/, "")}`
      : "";
  const hasUnsavedChanges =
    createNew
    || Boolean(displayName || nodeId || workspacePath)
    || userId !== (defaultUserId ?? "");
  const confirmDiscardChanges = useUnsavedChangesGuard(open && hasUnsavedChanges && !isBusy);

  async function requestClose() {
    if (isBusy) return;
    if (await confirmDiscardChanges()) onClose();
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={t("admin.v2.provision_kicker_node")}
      title={t("admin.v2.assign_title")}
      subtitle={t("admin.v2.assign_sub")}
      width="form"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
    >
      <form
        className="adm-form adm-assign-form"
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
      >
        {userLocked && selectedUser ? (
          <section className="adm-assign-operator" aria-label={t("admin.user")}>
            <span className="adm-assign-operator-eyebrow">
              {t("admin.user")}
            </span>
            <div className="adm-assign-operator-card">
              <span className="adm-assign-avatar" aria-hidden="true">
                {initialsOf(userHandleOf(selectedUser))}
              </span>
                <div className="adm-assign-operator-text">
                  {selectedUser.displayName &&
                  selectedUser.displayName !== selectedUser.id ? (
                    <span className="adm-assign-operator-name">
                      {selectedUser.displayName}
                    </span>
                  ) : null}
                  <span className="adm-assign-operator-handle code">
                    {displayHandle}
                  </span>
                </div>
            </div>
          </section>
        ) : (
          <section className="adm-assign-picker" aria-label={t("admin.user")}>
            {users.length === 0 ? (
              <p className="adm-form-hint adm-form-hint--notice">
                {t("admin.v2.add_node_no_users")}
              </p>
            ) : (
              <Field
                label={t("admin.user")}
                labelId={userLabelId}
                wrapper="div"
                error={fieldErrors.userId}
                errorId="assign-node-user-error"
              >
                <Select
                  value={userId || null}
                  onValueChange={(value) => {
                    setUserId(value ?? "");
                    clearFieldError("userId");
                  }}
                >
                  <SelectTrigger
                    ref={userTriggerRef}
                    data-modal-initial-focus
                    className="w-full code"
                    aria-labelledby={userLabelId}
                    aria-invalid={Boolean(fieldErrors.userId) || undefined}
                    aria-describedby={fieldErrors.userId ? "assign-node-user-error" : undefined}
                  >
                    <SelectValue placeholder={t("admin.select_user")}>
                      {(value: string | null) => {
                        if (!value) return t("admin.select_user");
                        const user = users.find((e) => e.id === value);
                        if (!user) return `@${value}`;
                        const handle = userHandleOf(user);
                        return user.displayName && user.displayName !== handle
                          ? `${user.displayName} / @${handle}`
                          : `@${handle}`;
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        {user.displayName && user.displayName !== userHandleOf(user)
                          ? `${user.displayName} / `
                          : ""}
                        <span className="text-muted-foreground">@{userHandleOf(user)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </section>
        )}

        <section className="adm-assign-nodes" aria-label={t("admin.assign_node")}>
          <header className="adm-assign-nodes-head">
            <span className="adm-assign-section-eyebrow">
              {t("admin.assign_node")}
            </span>
            <span className="adm-assign-nodes-count tnum">
              {unassignedNodes.length}
            </span>
          </header>

          {hasNodes ? (
            <RadioGroup
              render={<ul ref={nodeListRef} tabIndex={-1} />}
              className="adm-assign-node-list"
              name="assign-node-id"
              aria-label={t("admin.assign_node")}
              aria-describedby={fieldErrors.nodeId ? "assign-node-node-error" : undefined}
              value={createNew ? NEW_NODE_VALUE : nodeId}
              onValueChange={(value) => {
                setCreateNew(value === NEW_NODE_VALUE);
                setNodeId(value === NEW_NODE_VALUE ? "" : String(value));
                clearFieldError("nodeId");
              }}
            >
              {unassignedNodes.map((node) => {
                const status = visualStatus(node);
                const tone = statusTone(status);
                const isSelected = node.id === nodeId;
                return (
                  <li key={node.id}>
                    <RadioGroupChoice
                      className="adm-assign-node-choice"
                      value={node.id}
                      aria-invalid={Boolean(fieldErrors.nodeId) || undefined}
                    >
                      <span className={`adm-assign-node ${isSelected ? "selected" : ""}`}>
                        <NodePresence node={node} t={t} withLabel />
                        <span className="adm-assign-node-body">
                          <span className="adm-assign-node-id code" translate="no">
                            {node.displayName || node.id}
                          </span>
                          {node.workspacePath ? (
                            <span className="adm-assign-node-path code" translate="no">
                              {node.workspacePath}
                            </span>
                          ) : (
                            <span className="adm-assign-node-path muted">
                              {t("admin.workspace_none")}
                            </span>
                          )}
                          <NodeProfileBadges
                            node={node}
                            storedTokens={{}}
                            colocated={false}
                            t={t}
                            compact
                          />
                        </span>
                        <span className={`adm-assign-node-status tone-${tone}`}>
                          {t(`status.${status}`, { defaultValue: status })}
                        </span>
                        <span
                          className="adm-assign-node-check"
                          aria-hidden="true"
                        >
                          {isSelected ? <ActionApprove size={ICON.sm} /> : null}
                        </span>
                      </span>
                    </RadioGroupChoice>
                  </li>
                );
              })}
              <li>
                <RadioGroupChoice
                  className="adm-assign-node-choice"
                  value={NEW_NODE_VALUE}
                  aria-invalid={Boolean(fieldErrors.nodeId) || undefined}
                >
                  <span className={`adm-assign-node ${createNew ? "selected" : ""}`}>
                    <span className="adm-assign-node-dot tone-neutral" aria-hidden="true" />
                    <span className="adm-assign-node-body">
                      <span className="adm-assign-node-id">
                        <ActionAdd size={ICON.xs} aria-hidden="true" /> {t("admin.v2.assign_new_node_option")}
                      </span>
                      <span className="adm-assign-node-path muted">
                        {t("admin.v2.assign_new_node_hint")}
                      </span>
                    </span>
                    <span className="adm-assign-node-check" aria-hidden="true">
                      {createNew ? <ActionApprove size={ICON.sm} /> : null}
                    </span>
                  </span>
                </RadioGroupChoice>
              </li>
            </RadioGroup>
          ) : (
            <div className="adm-assign-empty" role="status">
              <AdminInbox size={ICON.lg} aria-hidden="true" />
              <div>
                <p className="adm-assign-empty-title">
                  {t("admin.no_unassigned_nodes")}
                </p>
                <p className="adm-assign-empty-body">
                  {t("admin.v2.assign_new_node_hint")}
                </p>
              </div>
            </div>
          )}
          {fieldErrors.nodeId ? (
            <FieldError id="assign-node-node-error">{fieldErrors.nodeId}</FieldError>
          ) : null}
        </section>

        {creatingNode ? (
          <fieldset className="adm-form-section">
            <legend className="adm-form-legend">{t("admin.v2.section_node")}</legend>
            <Field
              label={t("admin.v2.computer_name")}
              optional={t("admin.v2.optional")}
              hint={t("admin.v2.computer_name_hint")}
            >
              <Input
                name="assign-node-display-name"
                autoComplete="off"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t(isManaged ? "admin.v2.computer_name_placeholder_managed" : "admin.v2.computer_name_placeholder_local")}
                maxLength={64}
                disabled={isBusy}
              />
            </Field>
            <RunModeField
              value={nodeLocation}
              onChange={(location) => {
                setNodeLocation(location);
                setError(null);
              }}
              name="assign-node-location"
              disabled={isBusy}
            />
            {!isManaged ? (
              <Field
                label={t("nav.workspace_label")}
                hint={t("admin.v2.workspace_path_hint")}
                error={fieldErrors.workspacePath}
                errorId="assign-node-workspace-path-error"
              >
                <Input
                  ref={workspacePathRef}
                  name="assign-node-workspace-path"
                  autoComplete="off"
                  value={workspacePath}
                  onChange={(event) => {
                    setWorkspacePath(event.target.value);
                    clearFieldError("workspacePath");
                  }}
                  placeholder="/Users/alice/project"
                  disabled={isBusy}
                  aria-invalid={Boolean(fieldErrors.workspacePath) || undefined}
                  aria-describedby={fieldErrors.workspacePath ? "assign-node-workspace-path-error" : undefined}
                />
              </Field>
            ) : null}
            {/* RunModeField already states what the selected mode does; this
                line used to print the managed VM's behaviour underneath a local
                computer's configuration regardless of the choice. */}
            <p className="adm-form-hint">
              {t(isManaged ? "admin.v2.add_node_outcome_managed" : "admin.v2.add_node_outcome_local")}
            </p>
          </fieldset>
        ) : null}

        {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}

        <div className="adm-form-actions">
          <Button size="cta"
            type="button"
            variant="ghost"
            onClick={() => void requestClose()}
            disabled={isBusy}
          >
            {t("admin.v2.cancel")}
          </Button>
          <Button size="cta" type="submit" loading={isBusy} disabled={isBusy || blockedNoUsers}>
            {isBusy
              ? creatingNode
                ? t(isManaged ? "admin.creating" : "admin.v2.generating")
                : t("admin.assigning")
              : creatingNode
                ? t(isManaged ? "admin.v2.provision_node" : "admin.v2.generate_node")
                : t("admin.assign_node")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
