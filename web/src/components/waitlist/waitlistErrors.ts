import type { TFunction } from "i18next";
import { RelayApiError } from "../../api";

/** The words for a refused public request. A 400 or 409 carries the server's
    own sentence (a weak password, a taken handle), which is more useful than
    anything the client could guess; everything else is said in our voice so a
    stack trace or proxy page never reaches a visitor. */
export function publicRequestError(err: unknown, t: TFunction): string {
  if (!(err instanceof RelayApiError)) return t("login.error_generic");
  if ((err.status === 400 || err.status === 409) && err.message) return err.message;
  if (err.status === 429) return t("waitlist.error_rate_limited");
  if (err.status === 503) return t("waitlist.error_closed");
  if (err.status === 404) return t("waitlist.error_unavailable");
  return t("login.error_generic");
}
