# __APP_DISPLAY_NAME__

A small [Hono](https://hono.dev) server on Ryu's standalone services, built with
`@ryuhq/services`:

| Route | What it does | Needs |
|---|---|---|
| `POST /notify` | Publishes a notification with Ryu Notify | `RYU_NOTIFY_API_KEY` |
| `POST /mail` | Sends an email with Ryu Mail | `RYU_API_KEY` (a `ryu_` key with `mail:send`), `MAIL_FROM` |
| `POST /webhooks/mail` | Receives verified Mail webhook events | `MAIL_WEBHOOK_SECRET` |
| `POST /webhooks/notify` | Receives verified Notify destination deliveries | `NOTIFY_WEBHOOK_SECRET` |

> **Not yet on npm:** `@ryuhq/services` is not yet published to npm, so
> `bun install` cannot fetch it from the registry yet. Inside a Ryu monorepo
> checkout it resolves only when the project is a workspace member: scaffold it
> under `examples/` and run `bun install` at the repository root.

## Quickstart

1. **Install:** `bun install`
2. **Configure:** `cp .env.example .env`, then fill in the keys for the routes
   you want to use. Each variable is described in `.env.example`.
   The scaffolded `.gitignore` keeps `.env` out of version control.
3. **Run:** `bun dev`, then publish a notification:

   ```sh
   curl -X POST http://localhost:3000/notify \
     -H 'content-type: application/json' \
     -H 'idempotency-key: first-deploy' \
     -d '{"title":"Deploy finished","level":"success"}'
   ```

`bun test` runs every route against a stubbed Ryu, with no keys or network.

## Keys

- **Mail:** create a fine-grained `ryu_` key in the Ryu console with the
  `mail:send` scope. A key with only `mail:send` sends from an inbox ID, so set
  `MAIL_FROM` to the inbox's ID rather than its address. Set
  `RYU_ORGANIZATION_ID` when the key is a personal key.
- **Notify:** set `RYU_NOTIFY_API_KEY` to your Notify tenant key.
  `RYU_NOTIFY_URL` defaults to `https://notify.ryuhq.com`; set it only when Ryu
  issued you another origin.

Availability today:

- Mail: Available: hosted with a Ryu API key that has Mail scopes or a Ryu node gateway key, or self-hosted.
- Notify: Early access: hosted at https://notify.ryuhq.com with keys provisioned by Ryu; the self-hosted service is not yet published.

## Errors

Successful responses are `{ "data": … }` and failures `{ "error": { "code", "message", … } }`.
Every Ryu failure arrives as a typed `RyuError`; `toErrorResponse` in
`src/app.ts` maps it:

| Ryu failure | This server answers |
|---|---|
| `configuration_error` (a missing key; `missing` names the variables) | `500` |
| Ryu rejected the input (`400`, `422`) | `400` |
| Rate limited (`429`, with `Retry-After`) | `429` |
| Bad key, missing scope, Ryu unreachable | `502` |

`requestId` identifies the call for Ryu support.

## Webhooks

`webhookHandler` from `@ryuhq/services/webhooks` reads the raw body, checks the
signature and timestamp, and answers `401` for a forged or stale delivery
before your code runs. Handle verified events in `src/index.ts`
(`onMailEvent`, `onNotifyDelivery`). Deliveries can repeat: dedupe on the Mail
`event_id` or the Notify `deliveryId`.

## Learn more

- [SDK overview](https://docs.ryuhq.com/docs/standalone/sdk)
- [Mail](https://docs.ryuhq.com/docs/standalone/sdk/mail) and
  [Notify](https://docs.ryuhq.com/docs/standalone/sdk/notify)
- [Webhooks](https://docs.ryuhq.com/docs/standalone/sdk/webhooks) and
  [Errors](https://docs.ryuhq.com/docs/standalone/sdk/errors)
