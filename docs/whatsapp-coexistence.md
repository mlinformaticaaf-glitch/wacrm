# WhatsApp Business app + WACRM

This mode connects a number already active in the mobile WhatsApp Business
app through Meta Embedded Signup. It does not convert an API-only number
back into an app number or use WhatsApp Web pairing.

## Deployment prerequisites

1. Apply migrations `037_whatsapp_coexistence.sql`,
   `040_whatsapp_reliability.sql` and
   `041_whatsapp_coexistence_sync_claims.sql` and
   `042_whatsapp_webhook_settings.sql` before deploying this code. They add
   connection mode, message source, a sticky automation pause, BSUID
   identity, durable webhook events, lifecycle/sync state and atomic
   message persistence.
2. Configure the existing `META_APP_ID` and `META_APP_SECRET`, and set
   `META_EMBEDDED_SIGNUP_CONFIG_ID` to a Facebook Login for Business /
   Embedded Signup configuration enabled for Business app onboarding.
   The app must meet Meta's eligibility, permissions and access requirements.
   A configuration ID does not itself grant approval.
3. Allow the published HTTPS domain for the JavaScript SDK and OAuth flow
   in Meta. Subscribe the app webhook to `messages`,
   `smb_message_echoes`, `history`, `smb_app_state_sync` and
   `account_update`, and validate its callback URL. Preserve existing
   template-event subscriptions.
4. In Settings → WhatsApp, the account owner can save the webhook verification
   token independently of the phone number ID and permanent access token. The
   token is encrypted in the database and is never returned to the browser.
   Enter the same value as “Verify token” in the Meta webhook configuration.
   Existing WACRM tokens and `META_WEBHOOK_VERIFY_TOKEN` remain supported.
   Never commit secrets.
5. Set `WHATSAPP_WEBHOOK_RETRY_SECRET` and schedule
   `POST /api/whatsapp/webhook/retry` with a Bearer secret so transient
   processing failures are retried. Signed payloads are persisted before
   Meta receives a 2xx response.
6. Open Settings → WhatsApp → **Conectar meu WhatsApp Business** and
   complete Meta's connection/QR confirmation using the phone. Completion
   replaces this WACRM account's current configured number.

The server exchanges the authorization code without returning the access
token to the browser, verifies that the selected number belongs to the
returned account and has `is_on_biz_app=true` and `platform_type=CLOUD_API`,
subscribes the account, and stores the encrypted token. It never calls
the traditional PIN `/register` operation for this mode. Credential
updates also recheck coexistence and skip that operation.

## Manual takeover

The signed `smb_message_echoes` webhook resolves the customer by phone or
Business-scoped User ID (`to_user_id`), including users whose phone number
is unavailable. Supported text/media/location messages are stored as agent
messages with `source=whatsapp_business_app`; no customer unread increment,
first-inbound trigger, AI reply, or service-window refresh is generated
from these outgoing messages. App revoke and edit events update the
original stored message.

Echo persistence, sticky pause and active-flow termination are atomic.
Retries do not re-pause a conversation after an explicit resume. Late
echoes cannot replace the preview of a more recent message. Flows,
automation steps (including waits resumed by cron), and automated senders
check the pause. A send already accepted by Meta before the echo reaches
the CRM cannot be recalled.

**Retomar automação** clears the pause for future customer messages;
paused flow runs and previously cancelled steps are not replayed.

## Scope and production validation

The implementation starts Meta's one-shot contact and history sync after
onboarding and consumes `smb_app_state_sync`, `history`, and
`account_update`. Imported messages are deduplicated and do not increment
unread counts or trigger automations. Groups are not synchronized. The
customer must authorize history sharing on the phone, and Meta currently
limits native history to the most recent six months.

Each one-shot stream is claimed atomically before requesting it from Meta.
Claims are not automatically expired: if the process loses the response after
Meta accepted a request, retrying could start a duplicate one-shot sync. An
orphaned claim requires checking Meta's sync state before an administrator
clears it. Meta only permits each synchronization request once within 24 hours
of onboarding; both the phone's onboarding consent and Meta's eligibility
checks apply. Rejections include Meta's error details and `fbtrace_id` when
provided, which should be retained for Meta support if the API only returns a
generic error such as `135000`.

Before calling the integration live, validate with the actual eligible
number: Meta signup completed; mobile app still sends/receives; customer
messages arrive in WACRM; CRM sends appear on the phone; app replies appear
once in WACRM; automatic replies stop after app takeover; explicit resume
allows a new customer message to trigger automation. Verify all five
webhook fields are subscribed, rather than treating an account
subscription alone as proof of webhook delivery. Confirm contact/history
synchronization reached 100% within Meta's 24-hour onboarding window.

Official references:
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_app_state_sync/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update/
