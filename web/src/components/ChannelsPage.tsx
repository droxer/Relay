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
        title={t("admin.v2.title_channels")}
        subtitle={t("admin.v2.sub_channels")}
        titleVariant="display"
        layout="stacked"
        actions={
          hasChannels ? (
            // The shared create action names itself when the header has room.
            <Button
              type="button"
              variant="ghost"
              className="page-header-icon-action page-header-icon-action--primary page-header-create-action"
              tooltip={t("admin.v2.chat_create")}
              onClick={() => setCreateOpen(true)}
            >
              <ActionAdd size={ICON.md} aria-hidden="true" />
              <span className="page-header-create-label">{t("admin.v2.chat_create")}</span>
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
