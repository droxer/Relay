"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useDialogs } from "@/components/ui/DialogProvider";
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from "@/components/ui/dialog";
import { useDefaultAgentOffers } from "../../hooks/useDefaultAgentOffers";
import { useMutationError } from "../../hooks/useMutationError";
import { nextDefaultAgentOffer } from "../../lib/defaultAgentOffers";
import { agentLabel } from "../../lib/plan";
import type { DefaultAgentOffer } from "../../api";
import type { AgentName } from "../../types";
import { AgentMark } from "../AgentMark";
import { ICON } from "../icons";

/**
 * Asks, once per connected computer, whether to create a default agent for
 * each ready runtime it brought. Create makes the checked ones and declines
 * the rest; Skip declines them all. Closing the dialog answers nothing, so it
 * asks again next time the app loads.
 */
export function DefaultAgentsPrompt({ userId }: { userId: string }) {
  const { offers, answer, isAnswering } = useDefaultAgentOffers(userId);
  const [setAside, setSetAside] = useState<ReadonlySet<string>>(() => new Set());
  const offer = nextDefaultAgentOffer(offers, setAside);
  const putAside = (computerId: string) => setSetAside((current) => new Set([...current, computerId]));
  const bringBack = (computerId: string) =>
    setSetAside((current) => new Set([...current].filter((id) => id !== computerId)));

  return (
    <Dialog
      open={Boolean(offer)}
      onOpenChange={(next) => {
        if (!next && offer && !isAnswering) putAside(offer.computerId);
      }}
    >
      {offer ? (
        <DefaultAgentsDialog
          // A new computer's question starts with every runtime checked.
          key={offer.computerId}
          offer={offer}
          busy={isAnswering}
          onAnswer={(selected) => {
            // Hold the question until its answer lands, so a poll in between
            // cannot reopen it.
            putAside(offer.computerId);
            return answer({ offer, selected });
          }}
          onFailed={() => bringBack(offer.computerId)}
        />
      ) : null}
    </Dialog>
  );
}

function DefaultAgentsDialog({
  offer,
  busy,
  onAnswer,
  onFailed,
}: {
  offer: DefaultAgentOffer;
  busy: boolean;
  onAnswer: (selected: ReadonlySet<AgentName>) => Promise<unknown[]>;
  onFailed: () => void;
}) {
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const { reportMutationError } = useMutationError();
  const titleId = useId();
  const descriptionId = useId();
  const [selected, setSelected] = useState<ReadonlySet<AgentName>>(() => new Set(offer.executorKinds));

  const toggle = (kind: AgentName, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(kind);
      else next.delete(kind);
      return next;
    });
  };

  const submit = async (choice: ReadonlySet<AgentName>) => {
    try {
      const created = await onAnswer(choice);
      if (created.length > 0) {
        announce({
          message: t("default_agents.created", { count: created.length, computer: offer.computerName }),
          tone: "success",
        });
      }
    } catch (error) {
      onFailed();
      reportMutationError("Failed to answer the default agent offer", error, t("default_agents.error"));
    }
  };

  return (
    <DialogPortal>
      <DialogBackdrop className="dialog-backdrop" />
      <DialogViewport className="dialog-viewport">
        <DialogContent
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="dialog-modal"
        >
          <DialogTitle id={titleId} className="dialog-title" render={<h2 />}>
            {t("default_agents.title", { computer: offer.computerName })}
          </DialogTitle>
          <DialogDescription id={descriptionId} className="dialog-message" render={<p />}>
            {t("default_agents.body", { count: offer.executorKinds.length })}
          </DialogDescription>
          <ul className="default-agents-list" aria-label={t("default_agents.runtimes")}>
            {offer.executorKinds.map((kind) => {
              const checkboxId = `default-agent-${kind}`;
              return (
                <li key={kind} className="default-agents-row">
                  <Checkbox
                    id={checkboxId}
                    checked={selected.has(kind)}
                    disabled={busy}
                    onCheckedChange={(checked) => toggle(kind, checked)}
                  />
                  <label htmlFor={checkboxId} className="default-agents-label">
                    <AgentMark agent={kind} size={ICON.md} />
                    <span translate="no">{agentLabel(kind)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="dialog-message">{t("default_agents.hint")}</p>
          <div className="dialog-actions">
            <Button type="button" variant="ghost" size="cta" disabled={busy} onClick={() => void submit(new Set())}>
              {t("default_agents.skip")}
            </Button>
            <Button type="button" size="cta" disabled={busy || selected.size === 0} onClick={() => void submit(selected)}>
              {t("default_agents.create", { count: selected.size })}
            </Button>
          </div>
        </DialogContent>
      </DialogViewport>
    </DialogPortal>
  );
}
