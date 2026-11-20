import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import type {
  DaemonNodeEvent,
  DaemonWorkspaceEntry,
  DaemonWorkspaceErrorCode,
  DaemonWorkspaceListCommand,
  DaemonWorkspaceReadCommand,
} from "relay-core";
import { THREAD_RECORDS_DIR, THREAD_RECORDS_DIRS } from "./thread-workspace.js";

const DEFAULT_READ_LIMIT_BYTES = 256 * 1024;

// A file preview is "binary" only when the bytes cannot be text: a NUL
// anywhere (UTF-16 with a BOM is decoded below before this check) or bytes
// that are not valid UTF-8. A truncated read can split a multi-byte codepoint
// at the limit boundary, so the strict decode runs on the longest complete
// UTF-8 prefix — otherwise a large text file would be misreported as binary.
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF16_LE_DECODER = new TextDecoder("utf-16le");
const UTF16_BE_DECODER = new TextDecoder("utf-16be");

/** Length of the longest prefix of `raw` that does not end mid-codepoint. */
function completeUtf8PrefixLength(raw: Buffer): number {
  const end = raw.length;
  for (let i = Math.max(0, end - 3); i < end; i += 1) {
    const byte = raw[i];
    const sequenceLength = byte < 0x80 ? 0 : byte < 0xc2 ? -1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : byte < 0xf8 ? 4 : -1;
    if (sequenceLength > 0 && i + sequenceLength > end) return i;
  }
  return end;
}

/** Decoded UTF-8 content for preview, or null when the bytes are not text. */
function decodePreviewContent(raw: Buffer): Buffer | null {
  // UTF-16 with a BOM is unambiguous text; transcode so the preview pipeline
  // only ever carries UTF-8.
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return Buffer.from(UTF16_LE_DECODER.decode(raw.subarray(2)), "utf-8");
  }
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    return Buffer.from(UTF16_BE_DECODER.decode(raw.subarray(2)), "utf-8");
  }
  if (raw.includes(0)) return null;
  const prefix = raw.subarray(0, completeUtf8PrefixLength(raw));
  try {
    UTF8_DECODER.decode(prefix);
  } catch {
    return null;
  }
  return prefix;
}

export class WorkspaceReadError extends Error {
  constructor(readonly code: DaemonWorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceReadError";
  }
}

function resolveInsideBase(home: string, relativePath: string): { path: string; target: string } {
  const requested = relativePath.trim();
  if (requested.startsWith("/")) {
    throw new WorkspaceReadError("invalid-path", "Path must be relative to the workspace.");
  }
  const lexicalTarget = resolve(home, requested);
  if (lexicalTarget !== home && !lexicalTarget.startsWith(home + sep)) {
    throw new WorkspaceReadError("invalid-path", "Path escapes the workspace.");
  }
  const path = relativeHomePath(home, lexicalTarget);
  try {
    lstatSync(lexicalTarget);
  } catch {
    return { path, target: lexicalTarget };
  }
  try {
    const realHome = realpathSync(home);
    const realTarget = realpathSync(lexicalTarget);
    if (realTarget !== realHome && !realTarget.startsWith(realHome + sep)) {
      throw new WorkspaceReadError("invalid-path", "Path escapes the workspace through a symbolic link.");
    }
    return { path, target: realTarget };
  } catch (error) {
    if (error instanceof WorkspaceReadError) throw error;
    throw new WorkspaceReadError("io-error", error instanceof Error ? error.message : String(error));
  }
}

function relativeHomePath(home: string, target: string): string {
  return target === home ? "" : target.slice(home.length + 1).split(sep).join("/");
}

function compareEntries(left: DaemonWorkspaceEntry, right: DaemonWorkspaceEntry): number {
  return left.kind === right.kind
    ? left.name.toLowerCase().localeCompare(right.name.toLowerCase())
    : left.kind === "directory" ? -1 : 1;
}

export function listWorkspace(
  workspaceRoot: string,
  relativePath: string,
): { path: string; exists: boolean; entries: DaemonWorkspaceEntry[] } {
  const { path, target } = resolveInsideBase(resolve(workspaceRoot), relativePath);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(target);
  } catch {
    return { path, exists: false, entries: [] };
  }
  if (!stats.isDirectory()) throw new WorkspaceReadError("invalid-path", "Listing target is not a directory.");
  const entries: DaemonWorkspaceEntry[] = [];
  for (const name of readdirSync(target)) {
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(resolve(target, name));
    } catch {
      continue;
    }
    if (!info.isDirectory() && !info.isFile()) continue;
    entries.push({
      name,
      path: path ? `${path}/${name}` : name,
      kind: info.isDirectory() ? "directory" : "file",
      bytes: info.isDirectory() ? null : info.size,
      updatedAt: new Date(info.mtimeMs).toISOString(),
    });
  }
  entries.sort(compareEntries);
  return { path, exists: true, entries };
}

function listThreadRecords(workspaceRoot: string, path: string, current: ReturnType<typeof listWorkspace>): ReturnType<typeof listWorkspace> {
  if ((path !== THREAD_RECORDS_DIR && !path.startsWith(`${THREAD_RECORDS_DIR}/`))
    || path.split(/[\\/]/).includes("..")) {
    throw new WorkspaceReadError("invalid-path", "Activity listings require a path within the thread records directory.");
  }
  const relative = path.slice(THREAD_RECORDS_DIR.length);
  const listings = [...THREAD_RECORDS_DIRS.slice(1).reverse().map(root => listWorkspace(workspaceRoot, `${root}${relative}`)), current];
  const entries = new Map<string, DaemonWorkspaceEntry>();
  for (const listing of listings) {
    for (const entry of listing.entries) entries.set(entry.name, entry);
  }
  return {
    path: current.path,
    exists: listings.some(listing => listing.exists),
    entries: [...entries.values()].sort(compareEntries),
  };
}

export function readWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  limitBytes = DEFAULT_READ_LIMIT_BYTES,
): { path: string; bytes: number; isBinary: boolean; truncated: boolean; contentBase64?: string } {
  const { path, target } = resolveInsideBase(resolve(workspaceRoot), relativePath);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(target);
  } catch {
    throw new WorkspaceReadError("not-found", "Workspace file was not found.");
  }
  if (info.isDirectory()) throw new WorkspaceReadError("is-directory", "Workspace path is a directory.");
  if (!info.isFile()) throw new WorkspaceReadError("not-found", "Workspace path is not a regular file.");
  let raw: Buffer;
  let bytes: number;
  try {
    bytes = statSync(target).size;
    const handle = openSync(target, "r");
    try {
      raw = Buffer.alloc(Math.min(bytes, limitBytes));
      raw = raw.subarray(0, readSync(handle, raw, 0, raw.length, 0));
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    throw new WorkspaceReadError("io-error", error instanceof Error ? error.message : String(error));
  }
  // Binary files still ship their (capped) bytes so the preview can render
  // images and PDFs; text files are normalized to UTF-8 first.
  const content = decodePreviewContent(raw);
  return {
    path,
    bytes,
    isBinary: content === null,
    truncated: bytes > limitBytes,
    contentBase64: (content ?? raw).toString("base64"),
  };
}

type WorkspaceCommand = DaemonWorkspaceListCommand | DaemonWorkspaceReadCommand;
type WorkspaceCommandEvent = Extract<DaemonNodeEvent, {
  type: "workspace.listing" | "workspace.file" | "workspace.error";
}>;

export function workspaceCommandEvent(
  workspaceRoot: string,
  command: WorkspaceCommand,
): WorkspaceCommandEvent {
  try {
    if (command.type === "workspace.list") {
      const listing = listWorkspace(workspaceRoot, command.path);
      const event = {
        type: "workspace.listing" as const,
        commandId: command.id,
        ...(command.leaseId ? { leaseId: command.leaseId } : {}),
        ...listing,
      };
      if (command.threadRecordsMaxBytes === undefined) return event;
      const merged = {
        ...event, ...listThreadRecords(workspaceRoot, command.path, listing), threadRecordsMerged: true as const,
      };
      return Buffer.byteLength(JSON.stringify(merged)) <= command.threadRecordsMaxBytes ? merged : event;
    }
    const file = readWorkspaceFile(workspaceRoot, command.path, undefined);
    return {
      type: "workspace.file",
      commandId: command.id,
      ...(command.leaseId ? { leaseId: command.leaseId } : {}),
      path: file.path,
      bytes: file.bytes,
      isBinary: file.isBinary,
      truncated: file.truncated,
      ...(file.contentBase64 === undefined ? {} : { contentBase64: file.contentBase64 }),
    };
  } catch (error) {
    return {
      type: "workspace.error",
      commandId: command.id,
      ...(command.leaseId ? { leaseId: command.leaseId } : {}),
      path: command.path,
      code: error instanceof WorkspaceReadError ? error.code : "io-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
