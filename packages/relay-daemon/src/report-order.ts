interface OrderedReport { owner: string; sequence: number; terminal: boolean }
interface Stream { entries: Array<{ key: string; sequence: number }>; head: number; count: number }

/** Incremental per-lease order. Replay visits stream heads, never blocked tails. */
export class ReportOrder {
  private readonly streams = new Map<string, Stream>();
  private readonly terminals = new Set<string>();
  private readonly present = new Set<string>();

  add(key: string, report: OrderedReport): void {
    if (this.present.has(key)) return;
    this.present.add(key);
    if (report.terminal) { this.terminals.add(key); return; }
    let stream = this.streams.get(report.owner);
    if (!stream) {
      stream = { entries: [], head: 0, count: 0 };
      this.streams.set(report.owner, stream);
    }
    const entry = { key, sequence: report.sequence };
    // Normal capture appends. Recovery can read filenames in arbitrary order.
    let low = stream.head, high = stream.entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (stream.entries[middle].sequence <= entry.sequence) low = middle + 1;
      else high = middle;
    }
    stream.entries.splice(low, 0, entry);
    stream.count++;
  }

  remove(key: string, report: OrderedReport): void {
    if (!this.present.delete(key)) return;
    if (report.terminal) { this.terminals.delete(key); return; }
    const stream = this.streams.get(report.owner);
    if (!stream) return;
    if (--stream.count === 0) this.streams.delete(report.owner);
    else this.trim(stream);
  }

  private trim(stream: Stream): void {
    while (stream.head < stream.entries.length && !this.present.has(stream.entries[stream.head].key)) stream.head++;
    if (stream.head > 1024 && stream.head * 2 >= stream.entries.length) {
      stream.entries = stream.entries.slice(stream.head);
      stream.head = 0;
    }
  }

  ready(key: string, report: OrderedReport, selected: ReadonlySet<string> = new Set()): boolean {
    if (report.terminal) return true;
    const stream = this.streams.get(report.owner);
    if (!stream) return false;
    this.trim(stream);
    for (let i = stream.head; i < stream.entries.length; i++) {
      const other = stream.entries[i].key;
      if (!this.present.has(other) || selected.has(other)) continue;
      return other === key;
    }
    return false;
  }

  candidates(eligible: (key: string) => boolean, limit = 50): string[] {
    const keys: string[] = [];
    const examined: string[] = [];
    for (const key of this.terminals) {
      if (examined.length >= 200 || keys.length >= limit) break;
      examined.push(key);
      // Rotate quarantined terminal evidence as well as output owners.
      if (eligible(key)) keys.push(key);
    }
    for (const key of examined) {
      this.terminals.delete(key); this.terminals.add(key);
    }
    const owners: Array<[string, Stream, number]> = [];
    // Snapshot at most 200 owners; rotating a Map while iterating can loop forever.
    for (const [owner, stream] of this.streams) {
      owners.push([owner, stream, stream.head]);
      if (owners.length >= 200) break;
    }
    const rotated = new Set<string>();
    let progress = true;
    while (keys.length < limit && progress) {
      progress = false;
      for (const entry of owners) {
        const [owner, stream] = entry;
        if (!rotated.has(owner)) {
          this.streams.delete(owner); this.streams.set(owner, stream);
          rotated.add(owner);
        }
        while (entry[2] < stream.entries.length && !this.present.has(stream.entries[entry[2]].key)) entry[2]++;
        const key = stream.entries[entry[2]]?.key;
        if (!key || !eligible(key)) continue;
        keys.push(key); entry[2]++; progress = true;
        if (keys.length >= limit) break;
      }
    }
    return keys;
  }
}
