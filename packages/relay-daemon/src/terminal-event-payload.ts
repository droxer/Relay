// Leave room below the backend's default 4 MiB JSON body limit for the
// transcript and other completion fields. Count serialized bytes, including
// Base64 expansion, rather than the source files' sizes.
const TERMINAL_PAYLOAD_BYTES = 3 * 1024 * 1024;

export function terminalEventPayload(event: Record<string, unknown>, metadataOnly = false): Record<string, unknown> {
  const files = Array.isArray(event.generatedFiles) ? event.generatedFiles : [];
  let bytes = Buffer.byteLength(JSON.stringify(event));
  const generatedFiles = [...files];
  for (let index = files.length - 1; index >= 0; index--) {
    if (!metadataOnly && bytes <= TERMINAL_PAYLOAD_BYTES) break;
    const file = files[index];
    if (!file || typeof file !== "object" || typeof file.contentBase64 !== "string") continue;
    const { contentBase64: _content, ...metadata } = file;
    const replacement = { ...metadata, snapshotSkipped: "too-large" };
    bytes += Buffer.byteLength(JSON.stringify(replacement)) - Buffer.byteLength(JSON.stringify(file));
    generatedFiles[index] = replacement;
  }
  const result: Record<string, unknown> = { ...event, ...(files.length ? { generatedFiles } : {}) };
  // A server with a smaller configured limit may still reject the payload.
  // Exit evidence and artifact metadata take precedence over inline content.
  if (metadataOnly) delete result.agentLog;
  return result;
}

export async function sendTerminalEvent(send: typeof fetch, input: Parameters<typeof fetch>[0], init: RequestInit,
  event: Record<string, unknown>): Promise<Response> {
  const response = await send(input, init);
  if (response.status !== 413) return response;
  await response.body?.cancel();
  const compact = await send(input, { ...init, body: JSON.stringify(terminalEventPayload(event, true)) });
  // Never discard the only durable exit evidence or turn a successful run
  // into a failed one merely because the server refuses its representation.
  if (compact.status !== 413) return compact;
  await compact.body?.cancel();
  return new Response("Terminal event exceeds the server body limit.", { status: 503 });
}
