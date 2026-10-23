"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../i18n";
import { ScreenErrorBoundary } from "../components/ScreenErrorBoundary";

// Single QueryClient for the SPA. Created in state so it survives re-renders
// but is never shared across requests (irrelevant under static export, but the
// correct Next.js pattern). Defaults are tuned for an operational console:
// polling lives on each query's refetchInterval, and we avoid surprise
// refetches that would fight the live data already on screen.
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

/**
 * What every page needs: the query client and the error boundary. The
 * dialog, toast, tooltip, and artifact-viewer providers belong to the
 * signed-in surfaces alone (`SignedInProviders` in App.tsx), so the landing
 * page and the sign-in screens never download that stack.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <ScreenErrorBoundary>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ScreenErrorBoundary>
  );
}
