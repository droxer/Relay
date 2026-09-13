import { useTranslation } from "react-i18next";
import type { MentionCandidate } from "../../lib/mentions";
import { IdentityMark } from "../IdentityMark";
import { ProfileImage } from "../ProfileImagePicker";
import {
  Command,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** Id of the list the textarea points `aria-controls` at. */
export const MENTION_LIST_ID = "composer-mention-list";

/**
 * Autocomplete list for `@` in the composer, on the shared Combobox.
 *
 * The list renders INLINE — no Portal, no Positioner — the same shape the
 * command palette uses. That is deliberate: `.mention-popup` is positioned
 * against the composer card's inline padding so the list lines up with the
 * draft text rather than with the textarea's box, and an anchored positioner
 * would align it to the wrong edge.
 *
 * `filter` is null and `items` is already the match list: `useMentionAutocomplete`
 * finds the open `@…` fragment at the CARET and filters against that, which is
 * a substring of the input rather than the whole value. The primitive could
 * not derive that query itself, so it is given the answer and owns only the
 * listbox contract — the roving highlight, `aria-activedescendant`, the option
 * roles, and Enter-to-select.
 *
 * Ineligible agents stay listed but unselectable with their reason spelled
 * out — an agent that lives on another computer is a fact worth showing, not
 * an absence to puzzle over.
 */
export function MentionPopup({
  matches,
  onPick,
  children,
}: {
  matches: readonly MentionCandidate[];
  onPick: (candidate: MentionCandidate) => void;
  /** The composer textarea, rendered through `Combobox.Input`. */
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Command<MentionCandidate | null>
      open={matches.length > 0}
      items={matches as MentionCandidate[]}
      value={null}
      onValueChange={(candidate) => {
        if (candidate?.eligible) onPick(candidate);
      }}
      itemToStringLabel={(candidate) => candidate?.displayName ?? ""}
    >
      {children}
      {matches.length > 0 ? (
        <CommandList
          id={MENTION_LIST_ID}
          className="mention-popup"
          aria-label={t("composer.mention_list")}
        >
          {matches.map((candidate) => (
            <CommandItem
              key={candidate.id}
              value={candidate}
              disabled={!candidate.eligible}
              className="mention-option"
            >
              <ProfileImage
                src={candidate.profileImageUrl}
                alt=""
                fallback={<IdentityMark kind="agent" />}
                className="mention-option-mark"
              />
              <span translate="no">{candidate.displayName}</span>
              {candidate.reason ? (
                <span className="mention-option-reason">
                  {t(`composer.mention_reason.${candidate.reason}`)}
                </span>
              ) : null}
            </CommandItem>
          ))}
        </CommandList>
      ) : null}
    </Command>
  );
}
