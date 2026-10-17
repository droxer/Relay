// Translates `codex app-server` v2 notifications into the JSONL stream
// `codex exec --json` prints, so a run through the app-server adapter renders
// and parses (CodexStreamRenderer, token usage, runtime session id,
// collaboration events) exactly like an exec run. Pure: no I/O.

type Json = Record<string, unknown>;

/** One exec-style event, ready to print as a JSONL line. */
export type ExecEvent = Json;

/** Item types exec reports as `item.started` before their completion. */
const STARTED_ITEM_TYPES = new Set(["command_execution", "mcp_tool_call", "collab_tool_call", "web_search"]);

export class CodexExecEventTranslator {
  private threadId: string | undefined;
  private turnId: string | undefined;
  private nextItem = 0;
  private readonly itemIds = new Map<string, string>();
  /** Warnings that arrive before `thread.started`; exec prints them after it. */
  private readonly early: ExecEvent[] = [];
  private usageBaseline: Json | undefined;
  private usageTotal: Json | undefined;
  private todoId: string | undefined;
  private todoItems: Json[] = [];

  /** The thread is known: emit `thread.started`, then anything held back. */
  threadStarted(threadId: string): ExecEvent[] {
    this.threadId = threadId;
    const events = [{ type: "thread.started", thread_id: threadId }, ...this.early];
    this.early.length = 0;
    return events;
  }

  turnStarted(turnId: string): void {
    this.turnId = turnId;
  }

  /** Exec events for one server notification (often none). */
  notification(method: string, params: Json): ExecEvent[] {
    switch (method) {
      case "configWarning":
        return this.warning([str(params.summary), str(params.details)].filter(Boolean).join("\n  "));
      case "warning":
      case "deprecationNotice":
        if (params.threadId && params.threadId !== this.threadId) return [];
        return this.warning(str(params.message) || str(params.summary));
      case "error":
        if (!this.ours(params)) return [];
        return [{ type: "error", message: str(record(params.error).message) || "Codex error" }];
      case "turn/started":
        if (!this.ours(params)) return [];
        return [{ type: "turn.started" }];
      case "item/started":
        return this.ours(params) ? this.item("item.started", record(params.item)) : [];
      case "item/completed":
        return this.ours(params) ? this.item("item.completed", record(params.item)) : [];
      case "turn/plan/updated":
        return this.ours(params) ? this.plan(params) : [];
      case "thread/tokenUsage/updated":
        if (this.ours(params)) this.usage(record(params.tokenUsage));
        return [];
      case "turn/completed":
        return this.ours(params) ? this.turnCompleted(record(params.turn)) : [];
      default:
        return [];
    }
  }

  /** Whether the notification belongs to this run's thread and turn. */
  private ours(params: Json): boolean {
    if (params.threadId !== undefined && params.threadId !== this.threadId) return false;
    const turnId = params.turnId ?? record(params.turn).id;
    return turnId === undefined || this.turnId === undefined || turnId === this.turnId;
  }

  private warning(message: string): ExecEvent[] {
    if (!message) return [];
    const event = { type: "item.completed", item: { id: this.freshId(), type: "error", message } };
    if (this.threadId) return [event];
    this.early.push(event);
    return [];
  }

  private item(type: "item.started" | "item.completed", raw: Json): ExecEvent[] {
    const item = execItem(raw, () => this.idFor(str(raw.id)));
    if (!item) return [];
    if (type === "item.started" && !STARTED_ITEM_TYPES.has(String(item.type))) return [];
    return [{ type, item }];
  }

  private plan(params: Json): ExecEvent[] {
    this.todoItems = array(params.plan).map((step) => {
      const entry = record(step);
      return { text: str(entry.step), completed: entry.status === "completed" };
    });
    const started = this.todoId === undefined;
    this.todoId ??= this.freshId();
    return [{ type: started ? "item.started" : "item.updated", item: { id: this.todoId, type: "todo_list", items: this.todoItems } }];
  }

  private usage(tokenUsage: Json): void {
    const total = record(tokenUsage.total);
    // The first update of this turn fixes the baseline: whatever the thread had
    // spent before this turn's first request.
    this.usageBaseline ??= subtract(total, record(tokenUsage.last));
    this.usageTotal = total;
  }

  private turnCompleted(turn: Json): ExecEvent[] {
    const events: ExecEvent[] = [];
    if (this.todoId) events.push({ type: "item.completed", item: { id: this.todoId, type: "todo_list", items: this.todoItems } });
    if (turn.status === "completed") {
      events.push({ type: "turn.completed", usage: this.turnUsage() });
    } else {
      const message = turn.status === "interrupted" ? "turn interrupted" : str(record(turn.error).message) || "turn failed";
      events.push({ type: "turn.failed", error: { message } });
    }
    return events;
  }

  private turnUsage(): Json {
    const spent = subtract(this.usageTotal ?? {}, this.usageBaseline ?? {});
    return {
      input_tokens: num(spent.inputTokens),
      cached_input_tokens: num(spent.cachedInputTokens),
      cache_write_input_tokens: num(spent.cacheWriteInputTokens),
      output_tokens: num(spent.outputTokens),
      reasoning_output_tokens: num(spent.reasoningOutputTokens),
    };
  }

  private idFor(nativeId: string): string {
    let id = this.itemIds.get(nativeId);
    if (!id) {
      id = this.freshId();
      this.itemIds.set(nativeId, id);
    }
    return id;
  }

  private freshId(): string {
    return `item_${this.nextItem++}`;
  }
}

/** One v2 ThreadItem in exec's item shape; undefined for items exec never prints. */
export function execItem(item: Json, id: () => string): Json | undefined {
  switch (item.type) {
    case "agentMessage":
      return { id: id(), type: "agent_message", text: str(item.text) };
    case "reasoning": {
      const text = (array(item.summary).length ? array(item.summary) : array(item.content)).map(String).join("\n\n");
      return { id: id(), type: "reasoning", text };
    }
    case "commandExecution":
      return {
        id: id(),
        type: "command_execution",
        command: str(item.command),
        aggregated_output: str(item.aggregatedOutput),
        exit_code: typeof item.exitCode === "number" ? item.exitCode : null,
        status: snake(str(item.status)),
      };
    case "fileChange":
      return {
        id: id(),
        type: "file_change",
        changes: array(item.changes).map((change) => ({ path: str(record(change).path), kind: str(record(record(change).kind).type) })),
        status: snake(str(item.status)),
      };
    case "mcpToolCall": {
      const result = item.result ? record(item.result) : undefined;
      const error = item.error ? record(item.error) : undefined;
      return {
        id: id(),
        type: "mcp_tool_call",
        server: str(item.server),
        tool: str(item.tool),
        arguments: item.arguments ?? null,
        result: result ? { content: result.content ?? [], structured_content: result.structuredContent ?? null } : null,
        error: error ? { message: str(error.message) } : null,
        status: snake(str(item.status)),
      };
    }
    case "collabAgentToolCall":
      return {
        id: id(),
        type: "collab_tool_call",
        tool: snake(str(item.tool)),
        sender_thread_id: str(item.senderThreadId),
        receiver_thread_ids: array(item.receiverThreadIds).map(String),
        prompt: item.prompt ?? null,
        agents_states: Object.fromEntries(Object.entries(record(item.agentsStates)).map(([thread, state]) => [
          thread,
          { status: snake(str(record(state).status)), message: record(state).message ?? null },
        ])),
        status: snake(str(item.status)),
      };
    case "webSearch":
      return { id: id(), type: "web_search", query: str(item.query), action: item.action ?? null };
    default:
      return undefined;
  }
}

/** camelCase protocol enums ("inProgress", "spawnAgent") to exec's snake_case. */
export function snake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function subtract(a: Json, b: Json): Json {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Object.fromEntries([...keys].map((key) => [key, Math.max(0, num(a[key]) - num(b[key]))]));
}

function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
