import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonNodeCommand } from "relay-core";
import { syncDirectory } from "./sync-directory.js";
import type { ExecutionEvidence } from "./exit-proof.js";
import { isLinuxRunCgroup } from "./linux-run-cgroup.js";

export interface ExecutionRecord extends ExecutionEvidence {
  id: string;
  runId: string;
  sessionId: string;
  leaseId?: string;
  agent: string;
  recordedAt: string;
  stopRequested?: true;
}

type ExecutionCommand = Pick<ExecutionRecord, "id" | "runId" | "sessionId" | "leaseId" | "agent">;
type JournalRecord = ExecutionRecord & { prepared?: true };

/** A prepared record is written before the admission fence and cannot have launched.
 * Every other record, including legacy records, fences execution until exit is proven. */
export class ExecutionJournal {
  private readonly unreadable = new Set<string>();

  constructor(private readonly directory: string, private readonly onUnreadable?: (name: string, error: unknown) => void) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private filename(id: string): string {
    return `${createHash("sha256").update(id).digest("hex")}.json`;
  }

  has(id: string): boolean {
    const name = this.filename(id);
    if (this.unreadable.has(name) || statSync(join(this.directory, name), { throwIfNoEntry: false })) return true;
    // Distinguish an absent record from an unavailable journal directory.
    statSync(this.directory);
    return false;
  }

  get hasUnreadableRecords(): boolean { return this.unreadable.size > 0; }

  pending(): ExecutionRecord[] {
    const records: ExecutionRecord[] = [];
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = this.read(name);
        if (!record.prepared) records.push(record);
      } catch {
        // The file still fences its command even if we cannot identify the run.
      }
    }
    return records;
  }

  private read(name: string): JournalRecord {
    try {
      const record = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as Partial<JournalRecord>;
      if (!record || typeof record.id !== "string" || this.filename(record.id) !== name
        || typeof record.runId !== "string" || typeof record.sessionId !== "string"
        || typeof record.agent !== "string" || typeof record.recordedAt !== "string"
        || (record.leaseId !== undefined && typeof record.leaseId !== "string")
        || (record.processGroup !== undefined && (!Number.isSafeInteger(record.processGroup) || record.processGroup <= 0))
        || (record.spawnedAt !== undefined && !Number.isFinite(record.spawnedAt))
        || (record.cgroup !== undefined && !isLinuxRunCgroup(record.cgroup))
        || (record.stopRequested !== undefined && record.stopRequested !== true)
        || (record.prepared !== undefined && (record.prepared !== true || record.processGroup !== undefined
          || record.spawnedAt !== undefined || record.cgroup !== undefined || record.stopRequested !== undefined))) {
        throw new Error("Invalid execution journal record.");
      }
      this.unreadable.delete(name);
      return record as JournalRecord;
    } catch (error) {
      if (!this.unreadable.has(name)) {
        this.unreadable.add(name);
        this.onUnreadable?.(name, error);
      }
      throw error;
    }
  }

  admissionState(command: ExecutionCommand): "new" | "prepared" | "fenced" {
    if (!this.has(command.id)) return "new";
    const record = this.read(this.filename(command.id));
    return record.prepared && record.runId === command.runId && record.sessionId === command.sessionId
      && record.agent === command.agent && record.leaseId === command.leaseId ? "prepared" : "fenced";
  }

  mayHaveExecuted(id: string): boolean {
    return this.has(id) && !this.read(this.filename(id)).prepared;
  }

  prepare(command: ExecutionCommand): boolean {
    if (this.has(command.id)) return false;
    this.recordCommand(command, true);
    return true;
  }

  record(command: ExecutionCommand): boolean {
    if (this.has(command.id)) return false;
    this.recordCommand(command);
    return true;
  }

  commitPreparation(command: ExecutionCommand): boolean {
    if (this.admissionState(command) !== "prepared") return false;
    this.recordCommand(command);
    return true;
  }

  discardPreparation(id: string): void {
    if (this.has(id) && this.read(this.filename(id)).prepared) this.confirmExit(id);
  }

  private recordCommand(command: ExecutionCommand, prepared?: true): void {
    // Deliberately omit prompts, environment variables, and credentials.
    const { id, runId, sessionId, leaseId, agent } = command;
    this.write({ id, runId, sessionId, leaseId, agent, recordedAt: new Date().toISOString(), prepared });
  }

  /** Add where the run executed, so a restarted daemon can look for it. */
  attach(id: string, evidence: ExecutionEvidence): void {
    if (!this.has(id)) {
      if (evidence.cgroup) throw new Error("Cannot launch a contained execution without its journal record.");
      return;
    }
    const current = this.read(this.filename(id));
    if (current.prepared) throw new Error("Cannot attach execution evidence before admission commits.");
    if (evidence.cgroup) {
      this.write({ ...current, processGroup: undefined, spawnedAt: undefined, bootAt: undefined, ...evidence });
    } else {
      this.write({ ...current, cgroup: undefined, ...evidence });
    }
  }

  requestStop(command: Extract<DaemonNodeCommand, { type: "run.cancel" }>): boolean {
    if (!this.has(command.commandId)) return false;
    const record = this.read(this.filename(command.commandId));
    if (!record.cgroup || record.runId !== command.runId || record.sessionId !== command.sessionId
      || record.agent !== command.agent
      || (command.targetLeaseId !== undefined && record.leaseId !== command.targetLeaseId)) return false;
    if (!record.stopRequested) this.write({ ...record, stopRequested: true });
    return true;
  }

  private write(record: JournalRecord): void {
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, join(this.directory, this.filename(record.id)));
    syncDirectory(this.directory);
  }

  confirmExit(id: string): void {
    const name = this.filename(id);
    rmSync(join(this.directory, name), { force: true });
    syncDirectory(this.directory);
    this.unreadable.delete(name);
  }
}
