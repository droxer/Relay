export type ChatProvider = "discord" | "telegram" | "lark";
export type ChatIntegrationStatus = "draft" | "active" | "degraded" | "disabled";

export interface ChatIdentityLink {
  id: string;
  externalUserId: string;
  userId: string;
  displayName?: string | null;
  defaultAgentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatAllowedConversation {
  id: string;
  conversationId: string;
  threadId?: string | null;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatIntegration {
  id: string;
  provider: ChatProvider;
  displayName: string;
  tenantId?: string | null;
  status: ChatIntegrationStatus;
  config: Record<string, string | number | boolean>;
  health: {
    ok: boolean;
    message: string;
    lastCheckedAt?: string | null;
  };
  secretConfigured: boolean;
  secretKeys: string[];
  identityLinkCount: number;
  allowedConversationCount: number;
  identityLinks: ChatIdentityLink[];
  allowedConversations: ChatAllowedConversation[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatIntegrationsResponse {
  integrations: ChatIntegration[];
}
