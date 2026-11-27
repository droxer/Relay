import { createContext, useContext } from "react";
import type { RelayArtifact } from "../../types";

/** Render conditions the Markdown component overrides need.
 *
 * react-markdown's `components` map is built once and receives only the node's
 * own props, so there is no way to pass this down as a prop — context is the
 * seam. Kept in its own module so the overrides and the entry component can
 * both reach it without a cycle.
 */
type MarkdownMode = {
  /** The text is still being streamed and is a prefix of its final form. */
  live: boolean;
  /** Leading `@Agent` tokens to emphasize inline at the start of the first paragraph. */
  leadingMentions?: readonly string[];
  /** Known agent display names to emphasize inline wherever `@Agent` appears in prose. */
  inlineMentionNames?: readonly string[];
  /** Lowercased displayName -> canonical displayName for agents clickable to address in the composer. */
  mentionableNames?: ReadonlyMap<string, string>;
  /** Called when the user clicks an eligible `@Agent` pill in the transcript. */
  onMentionClick?: (displayName: string) => void;
};

const MarkdownModeContext = createContext<MarkdownMode>({ live: false });

export const MarkdownModeProvider = MarkdownModeContext.Provider;

export function useMarkdownMode(): MarkdownMode {
  return useContext(MarkdownModeContext);
}

export const MarkdownFileLinks = createContext<{
  resolve: (href: string) => RelayArtifact | undefined;
  open: (artifact: RelayArtifact) => void;
} | null>(null);
