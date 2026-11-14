import { apiJson } from "./client.ts";

/* The personal tag catalog (docs/api.md → "Personal tag catalog"). Saved names
   plus every tag on the signed-in person's own Tasks and Automations, counted
   in full. Rename, merge and delete are a preview, then an apply carrying the
   preview's token, so an apply never touches a record the preview did not
   show. */

export type TagEntry = { name: string; taskCount: number; automationCount: number; saved: boolean };

export type TagOperation =
  | { operation: "rename"; name: string; newName: string }
  | { operation: "merge"; sources: string[]; target: string }
  | { operation: "delete"; name: string };

export type TagExcludedReason = "project_unavailable" | "project_not_owned" | "project_disabled";

export type TagRecord = {
  id: string;
  number: number | null;
  title: string;
  isRoutine: boolean;
  tagsBefore: string[];
  tagsAfter: string[];
};

export type TagRecordGroup<T> = {
  taskCount: number;
  automationCount: number;
  items: T[];
  itemsTruncated: boolean;
};

export type TagPreview = {
  operation: TagOperation;
  previewToken: string;
  affected: TagRecordGroup<TagRecord>;
  excluded: TagRecordGroup<TagRecord & { reason: TagExcludedReason }>;
  catalog: { removes: string[]; saves: string | null };
};

export type TagApplyResult = {
  operation: TagOperation;
  updated: { taskCount: number; automationCount: number };
  excluded: { taskCount: number; automationCount: number };
  tags: TagEntry[];
};

export type TagCatalog = { tags: TagEntry[]; total: number };

export const listTags = () => apiJson<TagCatalog>("/account/tags");

export const createTag = (name: string) =>
  apiJson<{ tag: TagEntry }>("/account/tags", { method: "POST", body: { name } });

export const previewTagOperation = (operation: TagOperation) =>
  apiJson<TagPreview>("/account/tags/preview", { method: "POST", body: operation });

export const applyTagOperation = (operation: TagOperation, previewToken: string) =>
  apiJson<TagApplyResult>("/account/tags/apply", { method: "POST", body: { ...operation, previewToken } });
