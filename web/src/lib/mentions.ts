import type { UserAgent } from "../types.js";
import { isUserAgentRoutable } from "./agentDisplayNames.ts";
import type { AgentRoleIdentity } from "./agentRoleLabel.ts";

/** An agent that may be addressed from this thread's composer. */
export type MentionCandidate = AgentRoleIdentity & {
  id: string;
  displayName: string;
  profileImageUrl?: string | null;
  /** False when the agent cannot take a turn right now (offline, disabled).
   *  It stays in the list so the popup can say why. */
  eligible: boolean;
  reason?: "unavailable";
};

/** One `@…` token found in the addressing run at the head of the message. */
export type ParsedMention = {
  /** The resolved agent, or null when the name matches nothing (or is
   *  ambiguous) — an unresolved mention blocks the send. */
  agentId: string | null;
  text: string;
  start: number;
  end: number;
  eligible: boolean;
  reason?: MentionCandidate["reason"];
};

type ParsedMentions = {
  mentions: ParsedMention[];
  /** Agent ids this message addresses. Empty means the whole room. */
  addressAgentIds: string[];
  /** True when some mention cannot be dispatched, so the send must block. */
  blocked: boolean;
};

const MENTION_PREFIX = "@";

/**
 * The agents `@` can name in this thread.
 *
 * `agents` must already be scoped to the thread's computer — the same list the
 * composer's agent picker offers. A thread never leaves its computer, so an
 * agent placed elsewhere can never answer here; naming it in the popup only
 * invites a mention the dispatch would refuse. Keeping both surfaces on one
 * list is what makes the picker and `@` a single selection.
 */
export function mentionCandidates(
  agents: readonly UserAgent[],
): MentionCandidate[] {
  return agents
    .filter((agent) => !agent.deletedAt)
    .map((agent) => {
      const routable = isUserAgentRoutable(agent);
      return {
        id: agent.id,
        displayName: agent.displayName,
        profileImageUrl: agent.profileImageUrl,
        ...(agent.defaultRole ? { defaultRole: agent.defaultRole } : {}),
        ...(agent.roleLevel ? { roleLevel: agent.roleLevel } : {}),
        eligible: routable,
        ...(routable ? {} : { reason: "unavailable" as const }),
      };
    });
}

/**
 * Read the addressing run at the head of `text`.
 *
 * Only a leading run of consecutive mentions addresses the turn: "tell @Alice I
 * said hi" is a message to the room that happens to name her. The mentions are
 * never stripped from the message — being addressed by name is context the
 * agent should see.
 */
export function parseMentions(
  text: string,
  candidates: readonly MentionCandidate[],
): ParsedMentions {
  const mentions: ParsedMention[] = [];
  // With nobody to name, a leading `@Name` must stay blocked until the roster
  // loads. Treating it as prose would let the footer default address the room or
  // another agent — exactly the kind of fail-open routing mentions prevent.
  if (candidates.length === 0) {
    const start = leadingSpace(text);
    if (text.startsWith(MENTION_PREFIX, start)) {
      const rest = text.slice(start + MENTION_PREFIX.length);
      const end = start + MENTION_PREFIX.length + wordLength(rest);
      if (end > start + MENTION_PREFIX.length) {
        mentions.push({
          agentId: null,
          text: text.slice(start, end),
          start,
          end,
          eligible: false,
        });
        return { mentions, addressAgentIds: [], blocked: true };
      }
    }
    return { mentions, addressAgentIds: [], blocked: false };
  }
  // Longest name first, so "Support Bot" wins over a hypothetical "Support".
  const byLength = [...candidates].sort(
    (left, right) => right.displayName.length - left.displayName.length,
  );
  let cursor = leadingSpace(text);
  while (text.startsWith(MENTION_PREFIX, cursor)) {
    const rest = text.slice(cursor + MENTION_PREFIX.length);
    const matched = matchName(rest, byLength);
    if (!matched) {
      // An unknown name ends the run and blocks the send, so a typo never
      // silently becomes a message to the whole room.
      const end = cursor + MENTION_PREFIX.length + wordLength(rest);
      if (end === cursor + MENTION_PREFIX.length) break;
      mentions.push({
        agentId: null,
        text: text.slice(cursor, end),
        start: cursor,
        end,
        eligible: false,
      });
      cursor = end + leadingSpace(text.slice(end));
      continue;
    }
    const end = cursor + MENTION_PREFIX.length + matched.displayName.length;
    mentions.push({
      agentId: matched.eligible ? matched.id : null,
      text: text.slice(cursor, end),
      start: cursor,
      end,
      eligible: matched.eligible,
      ...(matched.reason ? { reason: matched.reason } : {}),
    });
    cursor = end + leadingSpace(text.slice(end));
  }
  const addressAgentIds = [
    ...new Set(
      mentions
        .filter((mention) => mention.eligible && mention.agentId)
        .map((mention) => mention.agentId as string),
    ),
  ];
  return {
    mentions,
    addressAgentIds,
    blocked: mentions.some((mention) => !mention.eligible),
  };
}

/** One run of the draft, either a mention or the plain text between two. */
type MentionSegment = {
  text: string;
  mention: boolean;
  /** Present only on mention runs; false is what makes one read as blocking. */
  eligible?: boolean;
};

/**
 * Cut `text` into the runs a highlight layer paints: mentions become pills,
 * everything else stays plain. Empty runs are dropped so the layer never
 * renders a zero-width span between two adjacent mentions.
 */
export function mentionSegments(
  text: string,
  mentions: readonly ParsedMention[],
): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.start > cursor) {
      segments.push({ text: text.slice(cursor, mention.start), mention: false });
    }
    segments.push({
      text: text.slice(mention.start, mention.end),
      mention: true,
      eligible: mention.eligible,
    });
    cursor = mention.end;
  }
  if (cursor < text.length || segments.length === 0) {
    segments.push({ text: text.slice(cursor), mention: false });
  }
  return segments;
}

/**
 * Rewrite the draft's leading address run to name `displayName` alone.
 *
 * The footer picker is single-select, so picking there means "this message goes
 * to exactly this agent". A leading mention outranks the picker at dispatch, so
 * without this the pick would look accepted in the footer and still route to
 * the named agent. Rewriting the run keeps one answer to "who runs this?".
 *
 * A draft with no leading mention is left untouched — the picker is already the
 * only selection there, and inserting text the author did not type would be a
 * surprise.
 */
export function replaceAddressRun(
  text: string,
  mentions: readonly ParsedMention[],
  displayName: string,
): string {
  if (mentions.length === 0) return text;
  const start = mentions[0].start;
  const end = mentions[mentions.length - 1].end;
  return `${text.slice(0, start)}${MENTION_PREFIX}${displayName}${text.slice(end)}`;
}

/** The `@…` fragment being typed at `caret`, or null when none is open. */
export function activeMentionQuery(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const upTo = text.slice(0, caret);
  const start = upTo.lastIndexOf(MENTION_PREFIX);
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(upTo[start - 1])) return null;
  const query = upTo.slice(start + MENTION_PREFIX.length);
  // A name may contain spaces, but a paragraph is not a name being typed.
  if (query.includes("\n") || query.split(" ").length > 3) return null;
  return { query, start };
}

/** Splice an accepted name into the draft, leaving the caret after it. */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  displayName: string,
): { text: string; caret: number } {
  const inserted = `${MENTION_PREFIX}${displayName} `;
  return {
    text: `${text.slice(0, start)}${inserted}${text.slice(caret)}`,
    caret: start + inserted.length,
  };
}

/**
 * Extract the exact leading `@Agent` mention tokens from a sent message.
 *
 * Mirrors `parseMentions` (longest-name-first, case-insensitive, whitespace
 * boundary) without requiring routability — a sent message keeps its visual
 * mention emphasis even if the addressed agent later goes offline.
 */
export function extractLeadingMentionTokens(
  text: string,
  agentNames: readonly string[],
): string[] {
  if (!text || agentNames.length === 0) return [];
  const byLength = [...new Set(agentNames.map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (byLength.length === 0) return [];
  const tokens: string[] = [];
  let cursor = leadingSpace(text);
  while (text.startsWith(MENTION_PREFIX, cursor)) {
    const rest = text.slice(cursor + MENTION_PREFIX.length);
    const lowered = rest.toLowerCase();
    const matched = byLength.find((name) => {
      const target = name.toLowerCase();
      return lowered === target || lowered.startsWith(`${target} `) || lowered.startsWith(`${target}\n`) || lowered.startsWith(`${target}\t`);
    });
    if (!matched) break;
    const end = cursor + MENTION_PREFIX.length + matched.length;
    tokens.push(text.slice(cursor, end));
    cursor = end + leadingSpace(text.slice(end));
  }
  return tokens;
}

/**
 * Split a leading text run into emphasized `@Agent` tokens and plain text.
 * Only consumes the exact tokens matched at the head of the message.
 */
export function splitLeadingMentionPrefix(
  text: string,
  tokens: readonly string[],
): Array<{ text: string; mention: boolean }> {
  if (!text || tokens.length === 0) return text ? [{ text, mention: false }] : [];
  const segments: Array<{ text: string; mention: boolean }> = [];
  let cursor = 0;
  for (const token of tokens) {
    const space = leadingSpace(text.slice(cursor));
    const tokenStart = cursor + space;
    if (!text.startsWith(token, tokenStart)) break;
    if (tokenStart > cursor) {
      segments.push({ text: text.slice(cursor, tokenStart), mention: false });
    }
    segments.push({ text: token, mention: true });
    cursor = tokenStart + token.length;
  }
  if (segments.length === 0) return [{ text, mention: false }];
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), mention: false });
  }
  return segments;
}

const ASCII_WORD = /[A-Za-z0-9_]/;
const ASCII_NAME_TAIL = /[A-Za-z0-9_-]/;

/**
 * Split prose into plain runs and inline `@Agent` mentions anywhere in `text`.
 *
 * Matches longest agent name first (case-insensitive), requiring a non-word
 * boundary before `@` (so emails like `user@Ada.com` are skipped) and a
 * non-identifier boundary after the name (so `@Ada` does not match `@Adam`,
 * while `@Ada,`, `@Ada。`, and `@Ada ` all match).
 */
export function splitInlineMentions(
  text: string,
  agentNames: readonly string[],
): Array<{ text: string; mention: boolean }> {
  if (!text) return [];
  if (!text.includes(MENTION_PREFIX) || agentNames.length === 0) {
    return [{ text, mention: false }];
  }
  const byLength = [...new Set(agentNames.map((name) => name.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (byLength.length === 0) return [{ text, mention: false }];

  const lowered = text.toLowerCase();
  const loweredNames = byLength.map((name) => name.toLowerCase());
  const segments: Array<{ text: string; mention: boolean }> = [];
  let plainStart = 0;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const atIndex = text.indexOf(MENTION_PREFIX, searchFrom);
    if (atIndex < 0) break;
    if (atIndex > 0 && ASCII_WORD.test(text[atIndex - 1])) {
      searchFrom = atIndex + 1;
      continue;
    }
    const nameStart = atIndex + MENTION_PREFIX.length;
    let matchedLen = 0;
    for (const candidate of loweredNames) {
      if (!lowered.startsWith(candidate, nameStart)) continue;
      const after = text[nameStart + candidate.length];
      if (after !== undefined && ASCII_NAME_TAIL.test(after)) continue;
      matchedLen = candidate.length;
      break;
    }
    if (matchedLen === 0) {
      searchFrom = nameStart;
      continue;
    }
    if (atIndex > plainStart) {
      segments.push({ text: text.slice(plainStart, atIndex), mention: false });
    }
    const end = nameStart + matchedLen;
    segments.push({ text: text.slice(atIndex, end), mention: true });
    plainStart = end;
    searchFrom = end;
  }

  if (segments.length === 0) return [{ text, mention: false }];
  if (plainStart < text.length) {
    segments.push({ text: text.slice(plainStart), mention: false });
  }
  return segments;
}

function matchName(
  rest: string,
  byLength: readonly MentionCandidate[],
): MentionCandidate | null {
  const lowered = rest.toLowerCase();
  const named = byLength.filter((candidate) => {
    const name = candidate.displayName.toLowerCase();
    return lowered === name || lowered.startsWith(`${name} `) || lowered.startsWith(`${name}\n`);
  });
  if (named.length === 0) return null;
  const best = named[0];
  // Two agents whose names are equally long both match: the mention is
  // ambiguous, so it resolves to nobody rather than guessing.
  const ambiguous = named.some(
    (candidate) =>
      candidate.id !== best.id
      && candidate.displayName.length === best.displayName.length,
  );
  return ambiguous ? null : best;
}

function wordLength(rest: string): number {
  const match = /^\S+/.exec(rest);
  return match ? match[0].length : 0;
}

function leadingSpace(text: string): number {
  const match = /^[^\S\n]*/.exec(text);
  return match ? match[0].length : 0;
}
