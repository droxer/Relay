import type { ChatIntegration, ChatIntegrationsResponse, ChatProvider } from "../types.ts";
import { apiJson } from "./client.ts";

export function listChatIntegrations(signal?: AbortSignal): Promise<ChatIntegrationsResponse> {
  return apiJson<ChatIntegrationsResponse>("/admin/chat-integrations", { signal });
}

export function createChatIntegration(input: {
  provider: ChatProvider;
  displayName: string;
  tenantId?: string;
  secrets?: Record<string, string>;
  config?: Record<string, string | number | boolean>;
}): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>("/admin/chat-integrations", {
    method: "POST",
    body: input,
  });
}

export function checkChatIntegration(integrationId: string): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/health-checks`,
    { method: "POST" },
  );
}

export function updateChatIntegration(
  integrationId: string,
  input: { displayName?: string; tenantId?: string; secrets?: Record<string, string>; config?: Record<string, string | number | boolean> },
): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}`,
    { method: "PATCH", body: input },
  );
}

export function activateChatIntegration(
  integrationId: string,
): Promise<{ integration: ChatIntegration; provisioning: { ok: boolean; message: string } }> {
  return apiJson<{ integration: ChatIntegration; provisioning: { ok: boolean; message: string } }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/activations`,
    { method: "POST" },
  );
}

export function rotateTelegramWebhookSecret(
  integrationId: string,
): Promise<{ integration: ChatIntegration; provisioning: { ok: boolean; message: string } }> {
  return apiJson<{ integration: ChatIntegration; provisioning: { ok: boolean; message: string } }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/webhook-secret-rotations`,
    { method: "POST" },
  );
}

export function addChatIdentityLink(
  integrationId: string,
  input: { externalUserId: string; userId: string; displayName?: string; defaultAgentId?: string },
): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/identity-links`,
    { method: "POST", body: input },
  );
}

export function deleteChatIdentityLink(integrationId: string, linkId: string): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/identity-links/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
}

export function addChatAllowedConversation(
  integrationId: string,
  input: { conversationId: string; threadId?: string; label?: string },
): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/allowed-conversations`,
    { method: "POST", body: input },
  );
}

export function deleteChatAllowedConversation(
  integrationId: string,
  conversationRecordId: string,
): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/allowed-conversations/${encodeURIComponent(conversationRecordId)}`,
    { method: "DELETE" },
  );
}
