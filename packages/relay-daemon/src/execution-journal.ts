import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ExecutionRecord {
  id: string;
  runId: string;
  sessionId: string;
  leaseId?: string;
  agent: string;
  recordedAt: string;
}

/** Admission identity survives daemon crashes. An unresolved record is never
 * exit evidence and must not cause a start to be executed again. */
export class ExecutionJournal {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private path(id: string): string {
    const key = createHash("sha256").update(id).digest("hex");
    return join(this.directory, `${key}.json`);
  }

  has(id: string): boolean { return existsSync(this.path(id)); }

  pending(): ExecutionRecord[] {
    return readdirSync(this.directory)
      .filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(join(this.directory, name), "utf8")) as ExecutionRecord);
  }

  record(command: Omit<ExecutionRecord, "recordedAt">): void {
    if (this.has(command.id)) return;
    // Deliberately omit prompts, environment variables, and credentials.
    const { id, runId, sessionId, leaseId, agent } = command;
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ id, runId, sessionId, leaseId, agent, recordedAt: new Date().toISOString() }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, this.path(id));
    this.syncDirectory();
  }

  confirmExit(id: string): void {
    rmSync(this.path(id), { force: true });
    this.syncDirectory();
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
