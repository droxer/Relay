import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { updateUserPreferences } from "../api";
import { onboardingProgress, type OnboardingInputs, type OnboardingPatch, type OnboardingProgress } from "../lib/onboarding";
import type { CurrentUser, OnboardingCard, OnboardingPrefs } from "../types";
import { omit } from "../lib/omit";
import { useMutationError } from "./useMutationError";

const now = () => new Date().toISOString();
// One identity, so an account with no record does not re-derive every render.
const NO_PREFS: OnboardingPrefs = {};

export type OnboardingControls = {
  progress: OnboardingProgress;
  /** The person read the intro and pressed Start. */
  start: () => void;
  dismiss: () => void;
  /** Bring a dismissed wizard back (the command menu's "Get started"). */
  reopen: () => void;
  closeCard: (card: OnboardingCard) => void;
};

type UseOnboardingInput = Omit<OnboardingInputs, "user"> & {
  user: CurrentUser;
  setUser: (user: CurrentUser) => void;
};

/**
 * The wizard's progress plus the four choices a person can make about it.
 * Each choice shows at once (an optimistic copy of the stored record) and is
 * written through PATCH /auth/preferences, whose response replaces the
 * session user. Saves run in order; only the last pending save clears the
 * optimistic copy, including when a write fails.
 */
export function useOnboarding({ user, setUser, nodes, agents, threads }: UseOnboardingInput): OnboardingControls {
  const { t } = useTranslation();
  const { reportMutationError } = useMutationError();
  const [optimistic, setOptimistic] = useState<OnboardingPrefs | null>(null);
  const prefs = optimistic ?? user.onboarding ?? NO_PREFS;
  const optimisticRef = useRef<OnboardingPrefs | null>(null);
  const saves = useRef<Promise<void>>(Promise.resolve());
  const latestSave = useRef(0);

  const progress = useMemo(
    () => onboardingProgress({ user: { ...user, onboarding: prefs }, nodes, agents, threads }),
    [agents, nodes, prefs, threads, user],
  );

  const save = useCallback((choice: (current: OnboardingPrefs) => {
    patch: OnboardingPatch;
    next: OnboardingPrefs;
  }) => {
    const { patch, next } = choice(optimisticRef.current ?? user.onboarding ?? NO_PREFS);
    const version = ++latestSave.current;
    optimisticRef.current = next;
    setOptimistic(next);
    // Keep writes in choice order. An earlier response may update the account,
    // but cannot remove the optimistic choices that are still waiting to save.
    saves.current = saves.current
      .then(() => updateUserPreferences({ onboarding: patch }))
      .then(({ user: updated }) => setUser(updated))
      .catch((error: unknown) => {
        reportMutationError("Failed to save onboarding progress", error, t("onboarding.save_error"));
      })
      .finally(() => {
        if (version === latestSave.current) {
          optimisticRef.current = null;
          setOptimistic(null);
        }
      });
  }, [reportMutationError, setUser, t, user.onboarding]);

  const start = useCallback(
    () => save((current) => ({
      patch: { introSeen: true },
      next: { ...current, introSeenAt: current.introSeenAt ?? now() },
    })),
    [save],
  );
  const dismiss = useCallback(
    () => save((current) => ({
      patch: { dismissed: true },
      next: { ...current, dismissedAt: current.dismissedAt ?? now() },
    })),
    [save],
  );
  const reopen = useCallback(
    () => save((current) => ({
      patch: { introSeen: true, dismissed: false, closedCards: [] },
      next: { ...omit(current, "dismissedAt", "closedCards"), introSeenAt: current.introSeenAt ?? now() },
    })),
    [save],
  );
  const closeCard = useCallback((card: OnboardingCard) => {
    save((current) => {
      const closedCards = [...new Set([...(current.closedCards ?? []), card])];
      return { patch: { closedCards }, next: { ...current, closedCards } };
    });
  }, [save]);

  return { progress, start, dismiss, reopen, closeCard };
}
