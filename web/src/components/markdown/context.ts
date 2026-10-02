import { createContext, useContext } from "react";

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
};

const MarkdownModeContext = createContext<MarkdownMode>({ live: false });

export const MarkdownModeProvider = MarkdownModeContext.Provider;

export function useMarkdownMode(): MarkdownMode {
  return useContext(MarkdownModeContext);
}
