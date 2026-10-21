"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getRuntimeRefresh, requestRuntimeRefresh } from "../../api";
import { Button } from "../ui/button";
import { ICON, NavRefresh } from "../icons";
import { useKeyChange } from "../../hooks/useKeyChange";

export function RuntimeRefreshButton({ nodeId, online, supported, busy }: {
  nodeId: string; online: boolean; supported: boolean; busy: boolean;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "pending" | "completed" | "failed">("idle");
  const [commandId, setCommandId] = useState<string>();
  const generation = useRef(0);
  useKeyChange(nodeId, () => {
    setCommandId(undefined);
    setStatus("idle");
  });
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [nodeId]);
  useEffect(() => {
    if (!commandId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await getRuntimeRefresh(nodeId, commandId);
        if (stopped) return;
        if (result.status === "completed") { setStatus("completed"); return; }
        if (result.status === "failed" || result.status === "cancelled") { setStatus("failed"); return; }
        timer = setTimeout(() => { void poll(); }, 2000);
      } catch {
        if (!stopped) setStatus("failed");
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [nodeId, commandId]);
  async function refresh() {
    const current = generation.current;
    setCommandId(undefined);
    setStatus("pending");
    try {
      const result = await requestRuntimeRefresh(nodeId);
      if (current === generation.current) setCommandId(result.commandId);
    } catch {
      if (current === generation.current) setStatus("failed");
    }
  }
  return <>
    {/* A quiet glyph beside the section label: refreshing is occasional, so
        it does not earn a labelled button on every card. The tooltip names
        it, and the outcome still reads out in words beside it. */}
    <Button type="button" variant="icon" size="icon-dense" onClick={() => { void refresh(); }}
      disabled={!online || !supported || status === "pending"}
      tooltip={supported ? t("computer.refresh_runtimes") : t("computer.refresh_upgrade")}>
      <NavRefresh size={ICON.sm} aria-hidden="true" />
    </Button>
    {status !== "idle" && <span role="status">{t(`computer.refresh_${status === "pending" && busy ? "waiting" : status}`)}</span>}
  </>;
}
