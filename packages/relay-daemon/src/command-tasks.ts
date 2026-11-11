interface TaskOptions {
  lane?: string;
  lease?: { commandId: string; leaseId?: string };
}

interface Task extends TaskOptions {
  key: string;
  work: () => Promise<void>;
}

/** Bounded background command work; a lane preserves workspace request order. */
export class CommandTasks {
  private readonly pending = new Map<string, Task>();
  private readonly queued: Task[] = [];
  private readonly running = new Set<Promise<void>>();
  private readonly lanes = new Set<string>();
  private closed = false;

  constructor(
    private readonly signal: AbortSignal,
    private readonly onError: (error: unknown, key: string) => void,
    private readonly concurrency = 4,
    private readonly capacity = 32,
  ) {}

  submit(key: string, work: () => Promise<void>, options: TaskOptions = {}): boolean {
    if (this.closed || this.signal.aborted || this.pending.has(key) || this.pending.size >= this.capacity) return false;
    const task = { key, work, ...options };
    this.pending.set(key, task);
    this.queued.push(task);
    this.pump();
    return true;
  }

  leases(): Array<{ commandId: string; leaseId?: string }> {
    return [...this.pending.values()].flatMap(task => task.lease ? [task.lease] : []);
  }

  private pump(): void {
    while (!this.closed && !this.signal.aborted && this.running.size < this.concurrency) {
      const index = this.queued.findIndex(task => !task.lane || !this.lanes.has(task.lane));
      if (index < 0) return;
      const [task] = this.queued.splice(index, 1);
      if (task.lane) this.lanes.add(task.lane);
      const promise = Promise.resolve().then(() => {
        this.signal.throwIfAborted();
        return task.work();
      }).catch(error => this.onError(error, task.key)).finally(() => {
        this.pending.delete(task.key);
        if (task.lane) this.lanes.delete(task.lane);
        this.running.delete(promise);
        this.pump();
      });
      this.running.add(promise);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.queued.splice(0)) this.pending.delete(task.key);
    await Promise.allSettled(this.running);
  }
}
