import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useMediaQuery } from "./useMediaQuery";
import { browserFrameSchedulerHost, createFrameScheduler, type FrameScheduler } from "../lib/frameScheduler";
import {
  advanceStreamingText,
  initialStreamingText,
  reconcileStreamingText,
} from "../lib/smoothStreamingText";

const STREAM_ANNOUNCEMENT_DELAY_MS = 600;

/**
 * Smooth irregular SSE chunks without restarting the reveal loop for each target
 * update. Frame callbacks read the latest committed inputs through an Effect Event.
 */
export function useSmoothStreamingText(text: string, streaming: boolean): string {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [visibleText, setVisibleText] = useState(() => initialStreamingText(text, streaming, false));
  const reconciledVisible = reconcileStreamingText(visibleText, text, streaming, reducedMotion);
  if (reconciledVisible !== visibleText) setVisibleText(reconciledVisible);
  const visibleRef = useRef(visibleText);
  // The reveal is frame-driven, but a page that is not painting (background
  // tab, occluded window) delivers no frames at all. Without the scheduler's
  // timer fallback the visible prefix freezes and the reply only appears once
  // the run settles — the whole answer arrives in one jump.
  const schedulerRef = useRef<FrameScheduler | undefined>(undefined);
  const previousTimeRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const scheduler = createFrameScheduler(browserFrameSchedulerHost());
    schedulerRef.current = scheduler;
    return () => {
      scheduler.cancel();
      schedulerRef.current = undefined;
    };
  }, []);

  const commitVisibleText = (next: string) => {
    if (next === visibleRef.current) return;
    visibleRef.current = next;
    setVisibleText(next);
  };

  const advance = useEffectEvent((time: number) => {
    const reconciled = reconcileStreamingText(
      visibleRef.current,
      text,
      streaming,
      reducedMotion,
    );
    commitVisibleText(reconciled);
    if (
      !streaming
      || reducedMotion
      || reconciled.length >= text.length
    ) {
      previousTimeRef.current = undefined;
      return false;
    }

    const elapsed = previousTimeRef.current === undefined ? 16 : time - previousTimeRef.current;
    previousTimeRef.current = time;
    const next = advanceStreamingText(reconciled, text, elapsed);
    commitVisibleText(next);
    const pending = next.length < text.length;
    if (!pending) previousTimeRef.current = undefined;
    return pending;
  });

  useEffect(() => {
    const reconciled = reconcileStreamingText(
      visibleRef.current,
      text,
      streaming,
      reducedMotion,
    );
    visibleRef.current = reconciled;
    if (!streaming || reducedMotion || reconciled.length >= text.length) {
      schedulerRef.current?.cancel();
      previousTimeRef.current = undefined;
      return;
    }
    const tick = (time: number) => {
      if (advance(time)) schedulerRef.current?.request(tick);
    };
    schedulerRef.current?.request(tick);
  }, [reducedMotion, streaming, text]);

  return reconciledVisible;
}

/** Debounce screen-reader announcements independently from the visual reveal. */
export function useDebouncedStreamingAnnouncement(text: string, streaming: boolean): string {
  const [announcement, setAnnouncement] = useState("");
  const [wasStreaming, setWasStreaming] = useState(streaming);
  if (wasStreaming !== streaming) {
    setWasStreaming(streaming);
    setAnnouncement("");
  }

  useEffect(() => {
    if (!streaming) return;
    const timeout = window.setTimeout(() => setAnnouncement(text), STREAM_ANNOUNCEMENT_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [streaming, text]);

  return streaming ? announcement : "";
}
