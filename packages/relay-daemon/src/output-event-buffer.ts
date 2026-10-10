export type OutputStream = "stdout" | "stderr";

export type BufferedOutput = {
  stream: OutputStream;
  text: string;
};

type OutputEventBufferOptions = {
  delayMs?: number;
  maxChars?: number;
  maxEntries?: number;
  /**
   * True while an earlier batch is still being delivered. The latency timer
   * then holds its flush so output arriving behind a slow post joins one batch
   * instead of queueing a post per window; `resume` releases it.
   */
  isBusy?: () => boolean;
};

const DEFAULT_DELAY_MS = 25;
const DEFAULT_MAX_CHARS = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 1_024;

function chunkEndWithoutSplittingSurrogate(text: string, offset: number, capacity: number): number {
  let end = Math.min(text.length, offset + capacity);
  const lastCodeUnit = text.charCodeAt(end - 1);
  const nextCodeUnit = text.charCodeAt(end);
  if (
    end < text.length
    && end > offset
    && lastCodeUnit >= 0xD800
    && lastCodeUnit <= 0xDBFF
    && nextCodeUnit >= 0xDC00
    && nextCodeUnit <= 0xDFFF
  ) {
    // A Unicode code point may use two UTF-16 code units. If it is the only
    // thing that fits, exceed the character budget by one rather than emit an
    // invalid lone surrogate; otherwise leave it for the next batch.
    end = end - offset === 1 ? end + 1 : end - 1;
  }
  return end;
}

/**
 * Coalesce raw subprocess chunks into small ordered live-output batches. Only
 * adjacent chunks from one stream are joined, preserving callback order.
 */
export class OutputEventBuffer {
  private entries: BufferedOutput[] = [];
  private bufferedChars = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private held = false;
  private readonly delayMs: number;
  private readonly maxChars: number;
  private readonly maxEntries: number;
  private readonly isBusy: () => boolean;

  constructor(
    private readonly emit: (entries: BufferedOutput[]) => void,
    options: OutputEventBufferOptions = {},
  ) {
    this.delayMs = Math.max(1, options.delayMs ?? DEFAULT_DELAY_MS);
    this.maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.isBusy = options.isBusy ?? (() => false);
  }

  push(stream: OutputStream, text: string): void {
    if (!text) return;
    let offset = 0;
    while (offset < text.length) {
      const remainingCapacity = this.maxChars - this.bufferedChars;
      if (remainingCapacity <= 0 || this.entries.length >= this.maxEntries) {
        this.flush();
        continue;
      }
      const end = chunkEndWithoutSplittingSurrogate(text, offset, remainingCapacity);
      const piece = text.slice(offset, end);
      const last = this.entries.at(-1);
      if (last?.stream === stream) last.text += piece;
      else this.entries.push({ stream, text: piece });
      this.bufferedChars += piece.length;
      offset = end;
      if (this.bufferedChars >= this.maxChars || this.entries.length >= this.maxEntries) {
        this.flush();
      }
    }
    if (this.entries.length === 0) return;
    if (this.timer || this.held) return;
    this.timer = setTimeout(() => this.flushWhenIdle(), this.delayMs);
    this.timer.unref?.();
  }

  /** Release a flush the latency timer held while delivery was busy. */
  resume(): void {
    if (this.held) this.flush();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.held = false;
    if (this.entries.length === 0) return;
    const entries = this.entries;
    this.entries = [];
    this.bufferedChars = 0;
    this.emit(entries);
  }

  private flushWhenIdle(): void {
    this.timer = undefined;
    if (this.isBusy()) {
      this.held = true;
      return;
    }
    this.flush();
  }

  close(): void {
    this.flush();
  }
}
