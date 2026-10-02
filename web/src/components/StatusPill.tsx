import { useTranslation } from "react-i18next";
import type { Tone } from "../types";
import type { StatusValue } from "../lib/threadStatus";
import { statusTone } from "../lib/statusTone";
import { StateMark } from "./StateMark";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Map the app's status tone vocabulary onto the shadcn Badge tone variants.
const TONE_VARIANT: Record<Tone, "success" | "info" | "danger" | "warning" | "neutral"> = {
  good: "success",
  info: "info",
  bad: "danger",
  warn: "warning",
  neutral: "neutral",
};

type TonePillProps = {
  tone: Tone;
  label: string;
  /** Active-work pulse: --live dot + pulse-ring at the --t-pulse cadence. */
  live?: boolean;
  title?: string;
  className?: string;
};

/**
 * The one tone-badge in the app: Badge draws the chrome, StateMark draws the
 * dot. Nothing here decides what a tone LOOKS like — StateMark owns the whole
 * shape grammar, so `bad` gets the hollow ring (a solid --err dot at this size
 * reads as emphasis, not as a problem) and `live` gets the pulse ring at the
 * --t-pulse cadence, in both cases from the same rules the board marks and the
 * node presence dots use. Reach for this instead of a bare `<Badge>`: a badge
 * without the mark is chrome with no status in it.
 */
export function TonePill({ tone, label, live = false, title, className }: TonePillProps) {
  return (
    <Badge variant={TONE_VARIANT[tone]} title={title} className={cn(className)}>
      <StateMark tone={live ? "live" : tone} />
      {label}
    </Badge>
  );
}

type StatusPillProps = { value: StatusValue };

export function StatusPill({ value }: StatusPillProps) {
  const { t } = useTranslation();
  return (
    <TonePill
      tone={statusTone(value)}
      label={t(`status.${value}`, { defaultValue: value })}
      live={value === "running" || value === "busy"}
    />
  );
}
