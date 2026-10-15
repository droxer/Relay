import { useTranslation } from "react-i18next";
import type { Tone } from "../types";
import { identityMonogram } from "../lib/identity";

type UserAvatarProps = {
  /** The user's display name — the initials come from it. Never pass the
      id: under the database auth store it is a UUID, and its "initials" are
      two hex digits. */
  displayName: string;
  running: boolean;
  tone?: Tone;
  size?: number;
  /** Pass the display name when the avatar stands alone (no adjacent visible
      name): it becomes role="img" with an accessible name that includes the
      live running state. Omit when a visible name sits next to the avatar —
      the avatar then stays aria-hidden decoration. */
  name?: string;
};

export function UserAvatar({ displayName, running, tone, size, name }: UserAvatarProps) {
  const { t } = useTranslation();
  const initials = identityMonogram(displayName);
  const style = size
    ? ({ "--avatar-size": `${size}px` } as React.CSSProperties)
    : undefined;
  const classes = [
    "user-avatar",
    running ? "running" : "",
    tone ? `tone-${tone}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const accessibility = name
    ? {
        role: "img" as const,
        "aria-label": running ? `${name} · ${t("status.running")}` : name,
      }
    : { "aria-hidden": "true" as const };
  return (
    <span className={classes} style={style} {...accessibility}>
      {initials}
    </span>
  );
}
