"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionAdd,
  ICON,
} from "./icons";
import { PageHeader } from "./PageHeader";
import { ChannelsView } from "./admin/ChannelsView";
import { Button } from "@/components/ui/button";

// Channels is a standard route, not part of the admin page; it shares the
// same shell + PageHeader chrome as the other top-level work pages.
export function ChannelsPage() {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const [hasChannels, setHasChannels] = useState(false);

  return (
    <section
      id="channels-panel"
      className="channels-page flex min-h-0 flex-col overflow-hidden"
      tabIndex={-1}
    >
      <PageHeader
        kicker={t("nav.manage")}
        title={t("admin.v2.title_channels")}
        subtitle={t("admin.v2.sub_channels")}
        titleVariant="display"
        layout="stacked"
        actions={
          hasChannels ? (
            // The shared list-header create affordance — a ghost plus, same
            // as every other list page; the header already names the list.
            <Button
              type="button"
              variant="ghost"
              className="page-header-icon-action page-header-icon-action--primary"
              tooltip={t("admin.v2.chat_create")}
              onClick={() => setCreateOpen(true)}
            >
              <ActionAdd size={ICON.md} aria-hidden="true" />
            </Button>
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 max-[820px]:p-4">
        <ChannelsView
          createOpen={createOpen}
          onCreateOpenChange={setCreateOpen}
          onHasChannelsChange={setHasChannels}
          showToolbarCreate={false}
        />
      </div>
    </section>
  );
}
