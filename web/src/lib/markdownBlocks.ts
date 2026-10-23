/**
 * Splits Markdown into top-level blocks that can be parsed independently.
 *
 * A streaming reply grows one frame at a time; re-parsing the whole text on
 * every frame makes the total work quadratic in its length. Splitting it into
 * blocks lets every settled block keep its rendered output while only the last
 * one — the block still being written — re-parses.
 *
 * The split is conservative: a boundary is a blank line outside any fence,
 * `$$` math block, HTML comment, or raw pre/script/style/textarea block, followed by an unindented line that cannot
 * continue the block before it (a list marker after a list stays with the
 * list, so a loose list does not become several lists). When the text defines
 * link references or footnotes, which resolve across the whole document, the
 * text is returned as a single block.
 *
 * Blocks keep their trailing blank lines, so `blocks.join("")` reproduces the
 * input exactly. A boundary needs the first character of the next block, so
 * earlier blocks are almost always final for any prefix of a stream; the rare
 * exception (a lone `2` after a list that becomes `2. b`) merges back on the
 * next frame and only costs that one block a re-parse.
 */
export function splitMarkdownBlocks(text: string): string[] {
  return createMarkdownBlockSplitter().split(text);
}

/**
 * A splitter that remembers where it left off. A streamed reply grows by a
 * few characters per frame; rescanning every line of it each frame made the
 * scan itself quadratic in the reply's length, the same way re-parsing was.
 * When the new text extends the last, scanning resumes at the first line
 * that had not ended yet — every boundary before it depends only on the
 * complete lines above, which have not changed. Any other text is scanned
 * from the start.
 */
export type MarkdownBlockSplitter = {
  split(text: string): string[];
  /** Characters the scanner has read in total; what the resume saves. */
  readonly scannedChars: number;
};

export function createMarkdownBlockSplitter(): MarkdownBlockSplitter {
  let previous = "";
  /** Boundaries found in complete lines, which no later frame can move. */
  let settledBoundaries: number[] = [];
  /** The scanner's state after the last complete line, and where that line ended. */
  let settledState = freshState();
  let settledAt = 0;
  let settledDefinitions = false;
  let scannedChars = 0;

  const reset = () => {
    previous = "";
    settledBoundaries = [];
    settledState = freshState();
    settledAt = 0;
    settledDefinitions = false;
  };

  return {
    get scannedChars() {
      return scannedChars;
    },
    split(text: string): string[] {
      if (text === "") {
        reset();
        return [];
      }
      if (!text.startsWith(previous)) reset();
      previous = text;
      // A definition resolves across the whole document, and the text only
      // ever grows past it, so once one has settled the answer stays one block.
      if (settledDefinitions) return [text];
      const scan = scanBoundaries(text, settledAt, cloneState(settledState));
      scannedChars += scan.scannedChars;
      if (scan.settledAt > settledAt) {
        settledBoundaries = settledBoundaries.concat(scan.boundaries.slice(0, scan.settledBoundaryCount));
        settledState = scan.settledState;
        settledAt = scan.settledAt;
        settledDefinitions = scan.settledDefinitions;
      }
      if (scan.hasDefinitions) return [text];
      const boundaries = settledBoundaries.concat(scan.boundaries.slice(scan.settledBoundaryCount));
      const blocks: string[] = [];
      let start = 0;
      for (const boundary of boundaries) {
        blocks.push(text.slice(start, boundary));
        start = boundary;
      }
      blocks.push(text.slice(start));
      return blocks;
    },
  };
}

type Fence = { char: "`" | "~"; length: number; indent: number };

/** CommonMark HTML block type 1: may contain blank lines and ends at its closing tag. */
const RAW_HTML_OPEN = /^ {0,3}<(pre|script|style|textarea)(?=[\s>]|$)/i;

type ScanState = {
  fence: Fence | null;
  inMath: boolean;
  /** Raw HTML (a comment or a pre/script/style/textarea block) that runs to this closer, blank lines included. */
  htmlCloser: string | null;
  inList: boolean;
  sawBlank: boolean;
};

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?:\s|$)/;
// Link reference and footnote definitions, also inside blockquotes and list
// items. Over-matching only costs the split, never correctness.
const DEFINITION = /^\s*(?:>\s*)*(?:(?:[-+*]|\d{1,9}[.)])\s+)?\[[^\]\n]+\]:/;

function freshState(): ScanState {
  return { fence: null, inMath: false, htmlCloser: null, inList: false, sawBlank: false };
}

function cloneState(state: ScanState): ScanState {
  return { ...state, fence: state.fence ? { ...state.fence } : null };
}

type BoundaryScan = {
  /** Boundaries found from `start` on, in order. */
  boundaries: number[];
  /** The text defines a link reference or footnote somewhere. */
  hasDefinitions: boolean;
  /** Where the last complete line ended; the scan is final up to here. */
  settledAt: number;
  /** How many of `boundaries` lie in complete lines. */
  settledBoundaryCount: number;
  settledState: ScanState;
  /** The definition sits in a complete line, so it stays. */
  settledDefinitions: boolean;
  scannedChars: number;
};

/** Scans `text` from `start` in `state`, which it advances. */
function scanBoundaries(text: string, start: number, state: ScanState): BoundaryScan {
  const boundaries: number[] = [];
  let offset = start;
  let settledAt = start;
  let settledBoundaryCount = 0;
  let settledState = cloneState(state);
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(offset, end).replace(/\r?\n$/, "");
    if (startsNewBlock(line, state)) boundaries.push(offset);
    const definition = scanLine(line, state);
    if (definition) {
      // A definition in a complete line settles with that line, so the next
      // frame answers without a scan; in an open line it is re-read.
      const settled = newline >= 0;
      return {
        boundaries: [],
        hasDefinitions: true,
        settledAt: settled ? end : settledAt,
        settledBoundaryCount: settled ? boundaries.length : settledBoundaryCount,
        settledState: settled ? cloneState(state) : settledState,
        settledDefinitions: settled,
        scannedChars: end - start,
      };
    }
    offset = end;
    if (newline >= 0) {
      settledAt = end;
      settledBoundaryCount = boundaries.length;
      settledState = cloneState(state);
    }
  }
  return {
    boundaries,
    hasDefinitions: false,
    settledAt,
    settledBoundaryCount,
    settledState,
    settledDefinitions: false,
    scannedChars: offset - start,
  };
}

function isOpaque(state: ScanState): boolean {
  return state.fence !== null || state.inMath || state.htmlCloser !== null;
}

/** Whether `line`, read in `state`, begins a new top-level block. */
function startsNewBlock(line: string, state: ScanState): boolean {
  if (!state.sawBlank || isOpaque(state) || line.trim() === "") return false;
  // Indented text continues a list item or an indented code block.
  if (/^\s/.test(line)) return false;
  if (state.inList && LIST_MARKER.test(line)) return false;
  return true;
}

/** Advances `state` past `line`. Returns true when the line is a definition. */
function scanLine(line: string, state: ScanState): boolean {
  if (state.fence) {
    if (closesFence(line, state.fence)) state.fence = null;
    return false;
  }
  if (state.htmlCloser) {
    if (line.toLowerCase().includes(state.htmlCloser)) state.htmlCloser = null;
    return false;
  }
  if (line.trim() === "") {
    state.sawBlank = true;
    return false;
  }
  const unindented = !/^\s/.test(line);
  if (state.sawBlank && unindented) state.inList = LIST_MARKER.test(line);
  else if (unindented && LIST_MARKER.test(line)) state.inList = true;
  state.sawBlank = false;

  if (state.inMath) {
    if (countDisplayMath(line) % 2 === 1) state.inMath = false;
    return false;
  }
  if (DEFINITION.test(line)) return true;
  const fence = openFence(line);
  if (fence) {
    state.fence = fence;
    return false;
  }
  if (countDisplayMath(line) % 2 === 1) state.inMath = true;
  const comment = line.lastIndexOf("<!--");
  if (comment >= 0 && !line.includes("-->", comment + 4)) state.htmlCloser = "-->";
  const raw = RAW_HTML_OPEN.exec(line);
  if (raw && !line.toLowerCase().includes(`</${raw[1].toLowerCase()}>`)) state.htmlCloser = `</${raw[1].toLowerCase()}>`;
  return false;
}

function openFence(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const [, indent, marker, info] = match;
  const char = marker[0] as Fence["char"];
  // A backtick fence's info string cannot contain a backtick (CommonMark).
  if (char === "`" && info.includes("`")) return null;
  return { char, length: marker.length, indent: indent.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^(\s*)(`+|~+)\s*$/.exec(line);
  if (!match) return false;
  const [, indent, marker] = match;
  return marker[0] === fence.char
    && marker.length >= fence.length
    && indent.length <= fence.indent + 3;
}

function countDisplayMath(line: string): number {
  return line.split("$$").length - 1;
}
