"use client";

import { useCallback } from "react";
import { useDialogs } from "@/components/ui/DialogProvider";
import { RelayApiError } from "../api";

export function useMutationError() {
  const { announce } = useDialogs();

  const reportMutationError = useCallback((
    context: string,
    error: unknown,
    message: string,
    action?: { label: string; onClick: () => void },
  ): void => {
    if (error instanceof RelayApiError) {
      console.warn(context, error.message);
    } else if (error != null) {
      console.error(context, error);
    }
    announce({ message, tone: "error", ...(action ? { action } : {}) });
  }, [announce]);

  return { reportMutationError };
}
