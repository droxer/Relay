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
  if (text === "") return [];
  const scan = scanBoundaries(text);
  if (scan.hasDefinitions) return [text];
  const blocks: string[] = [];
  let start = 0;
  for (const boundary of scan.boundaries) {
    blocks.push(text.slice(start, boundary));
    start = boundary;
  }
  blocks.push(text.slice(start));
  return blocks;
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

function scanBoundaries(text: string): { boundaries: number[]; hasDefinitions: boolean } {
  const boundaries: number[] = [];
  const state: ScanState = { fence: null, inMath: false, htmlCloser: null, inList: false, sawBlank: false };
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(offset, end).replace(/\r?\n$/, "");
    if (startsNewBlock(line, state)) boundaries.push(offset);
    if (scanLine(line, state)) return { boundaries: [], hasDefinitions: true };
    offset = end;
  }
  return { boundaries, hasDefinitions: false };
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
