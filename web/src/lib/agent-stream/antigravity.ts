import { asRecord } from "./builders.ts";
import { safeParse } from "./records.ts";

type ToolRouting = {
  source: string;
  offsets: readonly number[];
  tools: Map<string, number>;
  committed: readonly string[];
};

function toolCallId(line: string): string | undefined {
  if (!line.includes('"tool_use"')) return undefined;
  const event = safeParse(line);
  if (event?.type !== "tool_use") return undefined;
  const part = asRecord(event.part);
  const id = part.callID ?? part.id;
  return typeof id === "string" ? id : undefined;
}

/** Keep a call's updates with its first block, while other stdout follows the
 * steering boundaries. The cache commits complete lines so partial deliveries
 * can be redrawn without rescanning the completed transcript. */
export function routeAntigravityToolUpdates(
  source: string, offsets: readonly number[], previous?: ToolRouting,
): { routing: ToolRouting; stdoutByBlock: string[] } {
  const reuse = previous && source.startsWith(previous.source)
    && previous.offsets.every((offset, index) => offsets[index] === offset);
  let cursor = reuse ? previous.source.length : 0;
  const committed = reuse ? [...previous.committed] : [];
  let tools = reuse ? previous.tools : new Map<string, number>();
  let block = offsets.length - 1;
  while (block > 0 && cursor < offsets[block]) block--;
  let nextLine = source.indexOf("\n", cursor);
  while (nextLine >= 0) {
    while (block + 1 < offsets.length && cursor >= offsets[block + 1]) block++;
    const line = source.slice(cursor, nextLine + 1);
    const id = toolCallId(line);
    if (id && !tools.has(id)) {
      if (tools === previous?.tools) tools = new Map(tools);
      tools.set(id, block);
    }
    const destination = id ? tools.get(id) ?? block : block;
    committed[destination] = (committed[destination] ?? "") + line;
    cursor = nextLine + 1;
    nextLine = source.indexOf("\n", cursor);
  }
  const stdoutByBlock = offsets.map((_, index) => committed[index] ?? "");
  const tail = source.slice(cursor);
  const id = toolCallId(tail);
  const destination = (id ? tools.get(id) : undefined) ?? offsets.length - 1;
  stdoutByBlock[destination] += tail;
  return { routing: { source: source.slice(0, cursor), offsets, tools, committed }, stdoutByBlock };
}
