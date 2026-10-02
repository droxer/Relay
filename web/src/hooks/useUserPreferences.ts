import { useCallback, useEffect, useRef, useState } from "react";
import type { i18n as I18n } from "i18next";
import { updateUserPreferences } from "../api";
import type { CurrentUser } from "../types";
import {
  applyTheme,
  readLanguage,
  readTheme,
  writeLanguage,
  writeTheme,
  type Language,
  type Theme,
} from "../lib/appStorage";
import { useKeyChange } from "./useKeyChange";

/**
 * Theme and language: read once on mount, applied to the document, and written
 * back to the server optimistically.
 *
 * The bookkeeping below is what makes the optimistic write safe, and it is the
 * reason this is a hook rather than two `useState`s. A preference save is a
 * round trip the user can outrun — toggling twice quickly, or signing out
 * mid-flight — so each request carries:
 *
 *   generation      bumped on every sign-in/sign-out, so a response that
 *                   belongs to the previous user is dropped instead of being
 *                   written into the new one's session.
 *   latestRequestId only the newest request may commit; an earlier one that
 *                   resolves late is stale by definition.
 *   queue           serialises the writes, so two toggles cannot race to
 *                   decide the final stored value.
 *
 * A response failing any of those three checks is discarded — it neither
 * commits nor rolls back, because rolling back a stale request would undo a
 * newer choice the user has already seen applied.
 */
interface PreferenceRequestState {
  generation: number;
  latestRequestId: number;
  queue: Promise<void>;
}

function newPreferenceRequestState(generation = 0): PreferenceRequestState {
  return { generation, latestRequestId: 0, queue: Promise.resolve() };
}

interface UserPreferences {
  theme: Theme;
  language: Language;
  /** A user choice: applied optimistically and written to the server. */
  setTheme: (next: Theme) => void;
  /** A user choice: applied optimistically and written to the server. */
  setLanguage: (next: Language) => void;
  /**
   * Take the values the server already holds for a user who just signed in.
   * Deliberately NOT setTheme/setLanguage: those persist, and writing the
   * server's own value straight back to it on every sign-in would burn a
   * request and — worse — race the user's first real toggle.
   */
  adopt: (next: { theme: Theme; language: Language }) => void;
  /**
   * Call on sign-in and sign-out. Bumps the generation so any request already
   * in flight for the previous user can never commit into this one.
   */
  invalidate: (nextUserId: string | null) => void;
}

interface UserPreferencesInput {
  /** From useClientMounted. The export is prerendered, so touching
   *  localStorage before mount mismatches hydration. */
  mounted: boolean;
  i18n: I18n;
  setUser: (user: CurrentUser) => void;
  reportMutationError: (context: string, error: unknown, message: string) => void;
  /** Translated fallback for the failure toast. */
  saveErrorMessage: string;
}

export function useUserPreferences({
  mounted,
  i18n,
  setUser,
  reportMutationError,
  saveErrorMessage,
}: UserPreferencesInput): UserPreferences {
  const [theme, setThemeState] = useState<Theme>("system");
  const [language, setLanguageState] = useState<Language>("en");

  const authenticatedUserId = useRef<string | null>(null);
  const themeRequest = useRef<PreferenceRequestState>(newPreferenceRequestState());
  const languageRequest = useRef<PreferenceRequestState>(newPreferenceRequestState());

  useKeyChange(mounted, (isMounted) => {
    if (!isMounted) return;
    setThemeState(readTheme());
    setLanguageState(readLanguage());
  }, { from: false });

  useEffect(() => {
    // Wait for the stored preference to be read before applying/persisting;
    // otherwise the default "system" state clobbers the saved theme on every
    // load. Pre-paint theming is handled by the inline script in layout.tsx.
    if (!mounted) return;
    applyTheme(theme);
    writeTheme(theme);
    // Re-resolve "system" when the OS color scheme changes.
    if (theme !== "system" || typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mounted, theme]);

  useEffect(() => {
    if (!mounted) return;
    writeLanguage(language);
    document.documentElement.lang = language;
    document.title = i18n.t("app.title");
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
  }, [i18n, language, mounted]);

  const persist = useCallback((
    patch: { theme: Theme } | { language: Language },
    requestRef: { current: PreferenceRequestState },
    rollback: () => void,
    context: string,
  ): void => {
    const originatingUserId = authenticatedUserId.current;
    if (!originatingUserId) return;
    const generation = requestRef.current.generation;
    const requestId = ++requestRef.current.latestRequestId;
    const isCurrentRequest = () => (
      generation === requestRef.current.generation
      && requestId === requestRef.current.latestRequestId
      && originatingUserId === authenticatedUserId.current
    );
    requestRef.current.queue = requestRef.current.queue.then(async () => {
      if (!isCurrentRequest()) return;
      try {
        const { user: updatedUser } = await updateUserPreferences(patch);
        if (isCurrentRequest()) setUser(updatedUser);
      } catch (error) {
        if (!isCurrentRequest()) return;
        rollback();
        reportMutationError(context, error, saveErrorMessage);
      }
    });
  }, [reportMutationError, saveErrorMessage, setUser]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState((previous) => {
      if (next === previous) return previous;
      persist({ theme: next }, themeRequest, () => setThemeState(previous), "Failed to save theme preference");
      return next;
    });
  }, [persist]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState((previous) => {
      if (next === previous) return previous;
      persist({ language: next }, languageRequest, () => setLanguageState(previous), "Failed to save language preference");
      return next;
    });
  }, [persist]);

  const adopt = useCallback(({ theme: nextTheme, language: nextLanguage }: { theme: Theme; language: Language }) => {
    setThemeState(nextTheme);
    setLanguageState(nextLanguage);
  }, []);

  const invalidate = useCallback((nextUserId: string | null) => {
    authenticatedUserId.current = nextUserId;
    themeRequest.current = newPreferenceRequestState(themeRequest.current.generation + 1);
    languageRequest.current = newPreferenceRequestState(languageRequest.current.generation + 1);
  }, []);

  return { theme, language, setTheme, setLanguage, adopt, invalidate };
}
