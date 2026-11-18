const OMISSION = "\n[... output omitted ...]\n";

/** Bounded opening and latest output, with complete JSONL records at the gap. */
export class BoundedAgentTranscript {
  private opening = "";
  private tail: string[] = [];
  private tailHead = 0;
  private tailLength = 0;
  private tailBoundary = false;
  private truncated = false;
  private readonly headLimit: number;
  private readonly tailLimit: number;

  constructor(private readonly limit: number) {
    const budget = Math.max(0, limit - OMISSION.length);
    this.headLimit = Math.ceil(budget / 2);
    this.tailLimit = budget - this.headLimit;
  }

  append(value: string): void {
    if (!value) return;
    if (!this.truncated) {
      if (this.opening.length + value.length <= this.limit) {
        this.opening += value;
        return;
      }
      const previous = this.opening;
      this.opening = (previous + value.slice(0, this.headLimit)).slice(0, this.headLimit);
      this.truncated = true;
      this.appendTail(previous);
    }
    this.appendTail(value);
  }

  private appendTail(value: string): void {
    if (value.length > this.tailLimit) {
      const start = value.length - this.tailLimit;
      this.tailBoundary = value[start - 1] === "\n";
      this.tail = this.tailLimit ? [value.slice(start)] : [];
      this.tailHead = 0;
      this.tailLength = this.tailLimit;
      return;
    }
    this.tail.push(value);
    this.tailLength += value.length;
    while (this.tailLength > this.tailLimit) {
      const first = this.tail[this.tailHead]!;
      const removed = Math.min(first.length, this.tailLength - this.tailLimit);
      this.tailBoundary = first[removed - 1] === "\n";
      this.tailLength -= removed;
      if (removed === first.length) this.tailHead++;
      else this.tail[this.tailHead] = first.slice(removed);
    }
    if (this.tailHead > 1024 && this.tailHead * 2 > this.tail.length) {
      this.tail = this.tail.slice(this.tailHead);
      this.tailHead = 0;
    }
  }

  toString(): string {
    if (!this.truncated) return this.opening;
    if (this.limit <= OMISSION.length) return OMISSION.slice(0, this.limit);
    let head = this.opening;
    let tail = this.tail.slice(this.tailHead).join("");
    if (/^\s*\{/.test(head)) {
      // A cut JSON frame cannot be parsed by fallback or continuity consumers.
      head = head.slice(0, head.lastIndexOf("\n") + 1);
      if (!this.tailBoundary) {
        const newline = tail.indexOf("\n");
        tail = newline === -1 ? "" : tail.slice(newline + 1);
      }
    } else {
      // Do not split a UTF-16 surrogate pair around the omission marker.
      if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
      if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
    }
    return head + (head.endsWith("\n") ? OMISSION.slice(1) : OMISSION) + tail;
  }
}

export function truncateAgentTranscript(value: string, limit: number): string {
  const capture = new BoundedAgentTranscript(limit);
  capture.append(value);
  return capture.toString();
}
