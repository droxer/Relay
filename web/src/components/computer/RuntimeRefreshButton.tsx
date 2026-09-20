"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getRuntimeRefresh, requestRuntimeRefresh } from "../../api";
import { Button } from "../ui/button";

export function RuntimeRefreshButton({ nodeId, online, supported, busy }: {
  nodeId: string; online: boolean; supported: boolean; busy: boolean;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "pending" | "completed" | "failed">("idle");
  const [commandId, setCommandId] = useState<string>();
  const generation = useRef(0);
  useEffect(() => {
    setCommandId(undefined);
    setStatus("idle");
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
    <Button type="button" variant="outline" size="dense" onClick={() => { void refresh(); }}
      disabled={!online || !supported || status === "pending"}
      title={!supported ? t("computer.refresh_upgrade") : undefined}>
      {t("computer.refresh_runtimes")}
    </Button>
    {status !== "idle" && <span role="status">{t(`computer.refresh_${status === "pending" && busy ? "waiting" : status}`)}</span>}
  </>;
}
