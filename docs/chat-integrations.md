# Chat Integrations

> **Disabled by default.** The chat channels feature is switched off in the
> application. The backend does not mount `/api/v1/admin/chat-integrations` or
> `/api/v1/internal/chat/*` unless it runs with `RELAY_CHANNELS_ENABLED=1`, and
> the web UI has no Channels page, command, or shortcut unless it is built with
> `NEXT_PUBLIC_RELAY_CHANNELS_ENABLED=1`. Everything below describes the
> feature as it behaves once both are set.

Relay supports Discord, Telegram, Lark, and future chat clients through the
provider-neutral `relay-chat` package. Chat clients are control-plane clients:
they invoke agents through the Relay backend and never talk to daemon nodes
directly.

```text
chat provider event
  -> provider adapter
  -> relay-chat gateway
  -> Relay backend
  -> daemon node
  -> sandbox agent
  -> session events
  -> provider message update
```

## Integration Contract

Every provider adapter must normalize its platform event into the same Relay
chat model:

```ts
type ChatProvider = "discord" | "telegram" | "lark";

type ChatAgentRequest = {
  provider: ChatProvider;
  externalUserId: string;
  conversationId: string;
  threadId?: string;
  messageId?: string;
  tenantId?: string;
  sessionId?: string;
  agentId?: string;
  taskGoal: string;
};
```

Provider-specific IDs stay at the edge:

- Discord: user, guild, channel, thread, message IDs.
- Telegram: user, chat, message, and forum topic IDs.
- Lark: `open_id`, `union_id`, `chat_id`, `thread_id`, `root_id`, and
  `message_id`.

Relay-facing identity is always `employeeId`. Authorization remains a backend
responsibility.

## Required Configuration

Configure the Relay backend with a chat service token. Provider adapters use it
for identity resolution and employee-scoped run/status/cancel requests.

```bash
RELAY_CHAT_TOKEN=replace-with-a-random-secret
```

Configure each chat service with:

```bash
RELAY_BACKEND_URL=http://127.0.0.1:8790
RELAY_CHAT_TOKEN=replace-with-the-same-secret
RELAY_CHAT_PUBLIC_URL=https://chat.example.com
RELAY_CHAT_PORT=8791
```

Build and run `relay-chat-server` as a separate channel-plane service. It loads
only active integration credentials through the chat-service-authenticated
`GET /api/v1/internal/chat/integrations/runtime` endpoint, exposes provider webhook paths under
`/webhooks/<provider>/<integration-id>`, registers Discord's `/relay` command,
and delivers channel messages to Relay. Telegram setup is owned by Admin
Console -> Channels: activation registers and confirms the webhook using the
public HTTPS callback origin entered by the administrator. Lark and Discord
callback URLs must still be entered in their provider consoles.

Database-backed channel credentials additionally require a Fernet key. Keep it
in the deployment secret manager and retain it across restarts and rotations:

```bash
RELAY_CHAT_SECRET_KEY=<url-safe-base64-fernet-key>
```

When `relay-chat` calls the backend, it sends:

```http
Authorization: Bearer $RELAY_CHAT_TOKEN
X-Relay-Employee-Id: <employeeId>
```

The backend treats this as a non-admin employee actor. The actor can access only
records and logical agents allowed for that employee unless a route explicitly
allows public access.

## Web Setup

Admins configure chat clients in Relay Web:

1. Open **Admin Console -> Channels**.
2. Create a Discord, Telegram, or Lark integration.
3. Add the provider tenant or guild ID when the provider has one.
4. Store the provider secret. Relay records only whether a secret is configured
   in admin API responses; raw secret values are not returned.
5. Add identity links from provider user IDs to Relay `employeeId` values.
6. Add allowed conversations. Chat-triggered agent runs are rejected outside
   those channels, groups, chats, or threads.
7. Run **Check Setup**, then **Activate**.

The Admin Console uses `/api/v1/admin/chat-integrations`. Setup checks,
activation, and Telegram secret rotation are modeled as the
`health-checks`, `activations`, and `webhook-secret-rotations` subresources.

The admin setup creates a backend-owned configuration contract:

```text
chat_integrations
- provider
- tenant_id
- status
- public config
- health

chat_identity_links
- integration_id
- external_user_id
- employee_id
- default_agent_id

chat_allowed_conversations
- integration_id
- conversation_id
- thread_id
- label
```

Local development stores this under `.relay/chat/`. Secrets are isolated in a
separate local file with restrictive permissions. Production deployments should
back the same API contract with database storage and a managed secret store.

## Runtime Identity Resolution

Provider adapters should use backend-owned mappings rather than static files:

```ts
import { RelayChatIdentityResolver } from "relay-chat";

const identities = new RelayChatIdentityResolver({
  baseUrl: process.env.RELAY_BACKEND_URL,
  token: process.env.RELAY_CHAT_TOKEN,
});
```

The resolver calls:

```http
POST /api/v1/internal/chat/identity/resolve
Authorization: Bearer $RELAY_CHAT_TOKEN
Content-Type: application/json

{
  "provider": "discord",
  "tenantId": "guild-id",
  "externalUserId": "provider-user-id",
  "conversationId": "channel-or-chat-id",
  "threadId": "optional-thread-id"
}
```

The backend returns an employee identity only when the integration is active,
the provider conversation is allowlisted, and the provider user is linked.

## Shared Runtime Shape

Recommended package layout:

```text
packages/relay-chat/
  src/commands.ts
  src/gateway.ts
  src/identity.ts
  src/relay-client.ts
  src/providers/discord.ts
  src/providers/telegram.ts
  src/providers/lark.ts

```

`relay-chat` owns:

- parsing shared text commands,
- mapping provider references into Relay chat references,
- resolving chat users to employees,
- calling the Relay backend,
- streaming session events.

Provider services own:

- provider credentials,
- receiving provider events,
- sending/editing provider messages,
- provider-specific throttling and formatting.

## Identity Mapping

Start with static records:

```ts
import { StaticChatIdentityResolver } from "relay-chat";

const identities = new StaticChatIdentityResolver([
  {
    provider: "discord",
    tenantId: "discord-guild-id",
    externalUserId: "discord-user-id",
    employeeId: "alice",
    defaultAgentId: "agent_alice_builder",
  },
  {
    provider: "telegram",
    externalUserId: "telegram-user-id",
    employeeId: "alice",
    defaultAgentId: "agent_alice_builder",
  },
  {
    provider: "lark",
    tenantId: "lark-tenant-key",
    externalUserId: "lark-union-id-or-open-id",
    employeeId: "alice",
    defaultAgentId: "agent_alice_builder",
  },
]);
```

For production, move this into a database table:

```text
chat_identity_links
- provider
- tenant_id
- external_user_id
- employee_id
- default_agent_id
- created_at
- updated_at
```

Prefer stable organization-wide IDs:

- Discord: user ID scoped with guild ID.
- Telegram: user ID.
- Lark: `union_id` when available, otherwise `open_id` scoped with
  `tenant_key`.

## Shared Commands

Support the same logical commands everywhere:

```text
/relay run --agent agent_alice_builder fix the auth flow
/relay new --agent agent_alice_reviewer review this diff
/relay list
/relay switch sess_123
/relay status sess_123
/relay cancel sess_123 no longer needed
```

The current shared parser (`packages/relay-chat/src/commands.ts`) supports:

- `run` — start a session, optionally targeting an existing one with
  `--session`; `new` — always force a fresh session.
- `list` — list the conversation's known sessions.
- `switch <sessionId>` — change which session subsequent messages target.
- `status <sessionId>`
- `cancel <sessionId> [reason]`
- `--agent`
- `--session`

Provider adapters can expose richer native controls, but should normalize them
into these shared command kinds before calling the gateway.

## Gateway Usage

```ts
import {
  RelayChatClient,
  RelayChatGateway,
  StaticChatIdentityResolver,
  parseChatCommand,
  commandToAgentRequest,
} from "relay-chat";

const backend = new RelayChatClient({
  baseUrl: process.env.RELAY_BACKEND_URL,
  token: process.env.RELAY_CHAT_TOKEN,
});

const identities = new StaticChatIdentityResolver(identityRecords);
const gateway = new RelayChatGateway({ backend, identities });

async function handleText(ref, text, sink) {
  const command = parseChatCommand(text);
  if (!command) return;

  if (command.kind === "run") {
    const request = commandToAgentRequest(ref, command);
    if (!request) return;
    await gateway.run(request, sink);
  }

  if (command.kind === "status") {
    await gateway.status({ ...ref, sessionId: command.sessionId });
  }

  if (command.kind === "cancel") {
    await gateway.cancel({
      ...ref,
      sessionId: command.sessionId,
      reason: command.reason,
    });
  }
}
```

The sink adapts Relay events back to provider messages:

```ts
const sink = {
  started: async ({ session }) => {
    await postOrEdit(`Relay session ${session.id} started.`);
  },
  event: async ({ event }) => {
    if (event.type === "agent.output") {
      await appendProgress(event.text);
    }
  },
  completed: async (session) => {
    await postOrEdit(`Relay session ${session.id} ${session.status}.`);
  },
  failed: async (error) => {
    await postOrEdit(`Relay failed: ${String(error)}`);
  },
};
```

Throttle output updates. Agent output can be noisy, and provider edit APIs often
have rate limits or edit limits.

All webhook handlers require a `ProviderEventStore`. Use
`FileProviderEventStore` in deployed services so provider retries are deduplicated
across process restarts. Accepted work is retried with backoff until dispatch and
receipt persistence succeed; the in-memory implementation is intended only for
tests.

## Discord

For HTTP interactions, call `handleDiscordInteraction` with the exact raw body
and the `X-Signature-Timestamp` and `X-Signature-Ed25519` headers. Configure
`applicationId`, `publicKey`, and `botToken`; the handler verifies Ed25519 before
acknowledging the interaction and edits the deferred response as Relay runs.

Discord concepts:

- input: slash command interaction,
- user ID: `interaction.user.id`,
- tenant ID: `interaction.guildId`,
- conversation ID: `interaction.channelId`,
- thread ID: Discord thread ID, when applicable,
- first response: `deferReply()`,
- updates: `editReply()`, `followUp()`, or thread messages.

Normalize the interaction:

```ts
import { discordConversation } from "relay-chat";

const ref = discordConversation({
  userId: interaction.user.id,
  guildId: interaction.guildId ?? undefined,
  channelId: interaction.channelId,
  threadId: interaction.channel?.isThread() ? interaction.channel.id : undefined,
});
```

Recommended flow:

1. Register `/relay` slash commands with subcommands `run`, `status`, and
   `cancel`.
2. On command receipt, call `interaction.deferReply()`.
3. Resolve the Discord user to a Relay employee.
4. Call `RelayChatGateway`.
5. Edit the deferred reply with the session ID.
6. Send progress into a Discord thread or follow-up messages.

Use slash-command options for structured input:

```text
/relay run agent:agent_alice_builder prompt:"fix auth"
/relay status session:sess_123
/relay cancel session:sess_123 reason:"no longer needed"
```

## Telegram

Pass the exact webhook body and `X-Telegram-Bot-Api-Secret-Token` header to
`handleTelegramWebhook`. Configure both `botToken` and `webhookSecret`; the
handler rejects mismatched secrets, uses `sendMessage` for the durable progress
message, and updates it through `editMessageText`.

Telegram concepts:

- input: `Update.message`,
- user ID: `message.from.id`,
- conversation ID: `message.chat.id`,
- thread ID: `message.message_thread_id` for forum topics,
- first response: `sendMessage`,
- updates: `editMessageText`.

Normalize the message:

```ts
import { telegramConversation } from "relay-chat";

const ref = telegramConversation({
  userId: update.message.from.id,
  chatId: update.message.chat.id,
  messageThreadId: update.message.message_thread_id,
  messageId: update.message.message_id,
});
```

Recommended flow:

1. Production: configure `setWebhook` with `secret_token`.
2. Development: use `getUpdates` long polling.
3. Accept `/relay ...` text commands.
4. Send an initial progress message with `sendMessage`.
5. Store the returned `message_id`.
6. Update progress with `editMessageText`.

Webhook security:

- Use the Telegram webhook `secret_token`.
- Verify the `X-Telegram-Bot-Api-Secret-Token` header.
- Reject unknown update types.

Telegram messages have length limits. Summarize or link to Relay artifacts for
large output.

## Lark

Pass the exact callback body plus the Lark timestamp, nonce, and signature
headers to `handleLarkEvent`. Configure `appId`, `appSecret`,
`verificationToken`, and `encryptKey`; the handler verifies the callback,
decrypts encrypted payloads, handles URL verification, and sends coarse Relay
status updates through the Lark message API.

Lark concepts:

- input event: `im.message.receive_v1`,
- user ID: prefer `sender.sender_id.union_id`; fall back to `open_id`,
- tenant ID: `header.tenant_key`,
- conversation ID: `message.chat_id`,
- thread ID: `message.thread_id` or `message.root_id`,
- first response: `im.v1.message.create`,
- updates: `PUT /open-apis/im/v1/messages/:message_id` for text/post messages,
  or card update APIs for message cards.

Normalize the event:

```ts
import { larkConversation } from "relay-chat";

const ref = larkConversation({
  openId: event.sender.sender_id.open_id,
  unionId: event.sender.sender_id.union_id,
  tenantKey: header.tenant_key,
  chatId: event.message.chat_id,
  threadId: event.message.thread_id,
  rootId: event.message.root_id,
  messageId: event.message.message_id,
});
```

Recommended flow:

1. Create a Lark app with bot capability.
2. Subscribe to `im.message.receive_v1`.
3. Parse `event.message.content` as JSON and extract text.
4. Resolve the sender ID to `employeeId`.
5. Call `RelayChatGateway`.
6. Send initial status with `im.v1.message.create`.
7. Use text updates or interactive cards for progress.

Lark message updates have edit restrictions. Prefer coarse status updates:

- queued,
- running with current agent,
- waiting for human,
- completed or failed,
- artifact/session link.

## Security Requirements

- Never expose daemon node tokens to chat providers.
- Never let provider adapters call daemon-node routes directly.
- Store provider tokens and `RELAY_CHAT_TOKEN` in secrets management.
- Scope identity links by tenant/guild/workspace where the provider supports it.
- Verify webhook signatures or secret headers.
- Enforce allowlisted channels/groups for early rollout.
- Treat chat-triggered actions as employee actions in audit logs.
- Avoid posting full raw agent output into public channels.

## Operational Requirements

Persist these mappings:

```text
chat_conversations
- provider
- tenant_id
- conversation_id
- thread_id
- provider_message_id
- relay_session_id
- created_by_employee_id
- created_at
- updated_at
```

This lets the bot:

- route later `status` and `cancel` commands,
- recover after restart,
- update the correct provider message,
- avoid creating duplicate progress messages.

## Rollout Plan

1. Enable `RELAY_CHAT_TOKEN` in backend and one internal bot service.
2. Add static identity links for a small allowlist.
3. Ship `/relay run`, `/relay status`, and `/relay cancel`.
4. Limit to one private Discord guild/channel, Telegram chat, or Lark group.
5. Add persisted identity and conversation mappings.
6. Add channel/group allowlists and audit logs.
7. Add richer provider UI: Discord threads, Telegram inline buttons, Lark cards.
8. Add admin self-service linking and unlinking.

## Test Plan

Backend:

- chat token accepted with `X-Relay-Employee-Id`,
- missing or invalid chat token rejected,
- cross-employee sandbox access rejected,
- session SSE accepts chat actor identity.

Provider adapters:

- normalize provider IDs correctly,
- reject unlinked users,
- reject messages from disallowed channels/groups,
- throttle streamed output,
- preserve session/message mapping across restart.

End-to-end:

- `/relay run` creates a Relay session and posts session ID,
- agent output appears as throttled updates,
- `/relay status` returns the session state,
- `/relay cancel` cancels the active run,
- one employee cannot run another employee's sandbox.

## References

- [discord.js documentation](https://discord.js.org/docs)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Lark Open Platform documentation](https://open.larksuite.com/document/)
