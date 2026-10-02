import type { CodexCollaborationEvent, CodexSubagentStatus } from "relay-core";
import { omit } from "./omit.ts";

export interface CollaborationTreeNode {
  threadId: string;
  parentThreadId: string;
  label: string;
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  status: CodexSubagentStatus;
  message: string | null;
  children: CollaborationTreeNode[];
}

interface MutableNode extends Omit<CollaborationTreeNode, "children"> {
  childIds: string[];
}

/** Folds collaboration call history into the latest visible sub-agent tree. */
export function buildCollaborationTree(
  events: readonly CodexCollaborationEvent[],
  options: { settled?: boolean } = {},
): CollaborationTreeNode[] {
  const nodes = new Map<string, MutableNode>();
  for (const event of events) {
    if (event.tool === "spawnAgent") {
      for (const threadId of event.receiverThreadIds) {
        const existing = nodes.get(threadId);
        nodes.set(threadId, {
          threadId,
          parentThreadId: existing?.parentThreadId ?? event.senderThreadId,
          label: existing?.label ?? promptLabel(event.prompt, threadId),
          prompt: existing?.prompt ?? event.prompt,
          model: existing?.model ?? event.model,
          reasoningEffort: existing?.reasoningEffort ?? event.reasoningEffort,
          status: existing?.status ?? event.agentsStates[threadId]?.status ?? "pendingInit",
          message: event.agentsStates[threadId]?.message ?? existing?.message ?? null,
          childIds: existing?.childIds ?? [],
        });
        const parent = nodes.get(event.senderThreadId);
        if (parent && !parent.childIds.includes(threadId)) parent.childIds.push(threadId);
      }
    }
    for (const [threadId, state] of Object.entries(event.agentsStates)) {
      const node = nodes.get(threadId);
      if (node) {
        node.status = state.status;
        node.message = state.message;
      }
    }
  }

  // A parent may be observed after its child when events are replayed from a
  // partially retained stream, so rebuild child links after the fold.
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parentThreadId);
    if (parent && !parent.childIds.includes(node.threadId)) parent.childIds.push(node.threadId);
  }
  if (options.settled) {
    for (const node of nodes.values()) {
      if (node.status === "pendingInit" || node.status === "running") node.status = "completed";
    }
  }
  const roots = [...nodes.values()].filter((node) => !nodes.has(node.parentThreadId));
  return roots.map((node) => materialize(node, nodes, new Set()));
}

function materialize(node: MutableNode, nodes: Map<string, MutableNode>, ancestors: Set<string>): CollaborationTreeNode {
  if (ancestors.has(node.threadId)) return { ...withoutChildren(node), children: [] };
  const nextAncestors = new Set(ancestors).add(node.threadId);
  return {
    ...withoutChildren(node),
    children: node.childIds
      .map((threadId) => nodes.get(threadId))
      .filter((child): child is MutableNode => Boolean(child))
      .map((child) => materialize(child, nodes, nextAncestors)),
  };
}

function withoutChildren(node: MutableNode): Omit<CollaborationTreeNode, "children"> {
  return omit(node, "childIds");
}

function promptLabel(prompt: string | null, threadId: string): string {
  const firstLine = prompt?.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine) return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
  return `Sub-agent ${threadId.slice(0, 8)}`;
}
