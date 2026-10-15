# WhatsApp Web chat connector

Status: V1 self-host channel (experimental Chat connectors)

Paperclip can expose one company agent through a paired WhatsApp account using
[whatsapp-web.js](https://docs.wwebjs.dev/). This is a first-party Chat
connector (`provider: whatsapp-web`, `transport: chat_sdk`), not a plugin and not
WhatsApp Business Cloud.

## What V1 supports

- Pairing one WhatsApp account with a QR code (Linked devices)
- Direct-message text inbound and outbound
- Operator-controlled **automatic reply policy** (default: nobody)
- Issue binding, identity linking, and safe publication through the existing
  chat-channels subsystem

## Automatic reply policy

By default the endpoint does **not** wake the agent for inbound DMs
(`mode: none`). In connector Settings → Risposta automatica the operator chooses:

| Mode | Behavior |
| --- | --- |
| `none` | No automatic agent replies |
| `all` | Reply to every inbound DM |
| `allowlist` | Reply only to listed phone numbers / chat ids |
| `blocklist` | Reply to everyone except the listed contacts |
| `new_only` | Reply only the first time a contact is seen |

Setup verification (`status: verifying`) still accepts the first inbound DM so
pairing can complete. After activation, the policy gate applies before
`handleSdkMessage` / agent wakeup.

## What V1 does not support

- Groups, media, stickers, polls, or channels
- WhatsApp **Status** (Stories): inbound Status updates are dropped and never
  wake the agent; outbound publication to `status@broadcast` (or any
  `@broadcast` target) is rejected
- Multi-replica shared sessions / Paperclip Cloud Chromium hosting
- Official Meta WhatsApp Business Cloud webhooks

## Prerequisites

1. Enable **Chat connectors** in instance Experimental settings.
2. Self-host Paperclip with a working Chromium for Puppeteer
   (`PUPPETEER_EXECUTABLE_PATH` when the bundled browser is unavailable).
3. Prefer a dedicated phone number. Unofficial clients can be restricted by
   WhatsApp.
4. No public HTTPS webhook URL is required.

## Session storage

LocalAuth data is stored under:

```text
data/whatsapp-web/<companyId>/<endpointId>/
```

Override the root with `PAPERCLIP_WHATSAPP_WEB_DATA_DIR`.

Only one process should own a live Chromium session for an endpoint. Paperclip
uses the `whatsapp_web_runtime` chat endpoint lease (same pattern as Discord /
iMessage Photon).

## Setup journey

1. Connectors → WhatsApp Web → Chat with an agent
2. Choose the agent (permanent for this connection)
3. Show QR code and scan from WhatsApp → Linked devices
4. Wait until the connection shows paired / ready
5. Send a DM to the paired account to verify inbound delivery
6. Link the sender identity in Access when prompted

## Smoke checklist

- [ ] Chat connectors enabled
- [ ] Chromium available to the API process
- [ ] QR appears and scan completes without `auth_failure`
- [ ] Endpoint status becomes verifying/active with `botExternalId` set
- [ ] Inbound DM creates or continues a Paperclip issue
- [ ] Agent reply appears as a WhatsApp text message
- [ ] Pause / remove stops the local session; re-pair works after remove only for
      a new connection when identity uniqueness requires it

## Risks

This connector is unofficial. WhatsApp may ban or challenge the paired account.
Treat it as self-host / lab tooling, not a production Meta Business API
replacement.
