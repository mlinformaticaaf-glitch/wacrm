# WhatsApp Business app + WACRM

This mode connects a number already active in the mobile WhatsApp Business
app through Meta Embedded Signup. It does not convert an API-only number
back into an app number or use WhatsApp Web pairing.

## Deployment prerequisites

1. Apply `supabase/migrations/037_whatsapp_coexistence.sql` before deploying
   this code. It adds connection mode, message source, a sticky automation
   pause, and the service-role-only atomic echo persistence function.
2. Configure the existing `META_APP_ID` and `META_APP_SECRET`, and set
   `META_EMBEDDED_SIGNUP_CONFIG_ID` to a Facebook Login for Business /
   Embedded Signup configuration enabled for Business app onboarding.
   The app must meet Meta's eligibility, permissions and access requirements.
   A configuration ID does not itself grant approval.
3. Allow the published HTTPS domain for the JavaScript SDK and OAuth flow
   in Meta. Subscribe the app webhook to `messages` and
   `smb_message_echoes` and validate its callback URL. Preserve existing
   template-event subscriptions.
4. Existing WACRM connections retain their encrypted webhook verification
   token. For a first connection, set `META_WEBHOOK_VERIFY_TOKEN` to the
   token already validated for the app callback. Never commit secrets.
5. Open Settings → WhatsApp → **Conectar meu WhatsApp Business** and
   complete Meta's connection/QR confirmation using the phone. Completion
   replaces this WACRM account's current configured number.

The server exchanges the authorization code without returning the access
token to the browser, verifies that the selected number belongs to the
returned account and has `is_on_biz_app=true` and `platform_type=CLOUD_API`,
subscribes the account, and stores the encrypted token. It never calls
the traditional PIN `/register` operation for this mode. Credential
updates also recheck coexistence and skip that operation.

## Manual takeover

The signed `smb_message_echoes` webhook uses `message_echoes[].to` as the
customer number. Supported text/media/location messages are stored as
agent messages with `source=whatsapp_business_app`; no customer unread
increment, first-inbound trigger, AI reply, or service-window refresh
is generated from these outgoing messages.

Echo persistence, sticky pause and active-flow termination are atomic.
Retries do not re-pause a conversation after an explicit resume. Late
echoes cannot replace the preview of a more recent message. Flows,
automation steps (including waits resumed by cron), and automated senders
check the pause. A send already accepted by Meta before the echo reaches
the CRM cannot be recalled.

**Retomar automação** clears the pause for future customer messages;
paused flow runs and previously cancelled steps are not replayed.

## Scope and production validation

This implementation syncs new app-sent text, image/sticker, video,
audio, document and location messages. It does not import past chat
history or contact history, mirror groups, or process app edit/revoke
and reaction events. Do not advertise historical import.

Before calling the integration live, validate with the actual eligible
number: Meta signup completed; mobile app still sends/receives; customer
messages arrive in WACRM; CRM sends appear on the phone; app replies appear
once in WACRM; automatic replies stop after app takeover; explicit resume
allows a new customer message to trigger automation. Verify the app has
the `smb_message_echoes` subscription, rather than treating an account
subscription alone as proof of webhook delivery.

References: Meta's Business App onboarding documentation,
https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
and provider documentation for their live integration examples:
https://www.infobip.com/docs/whatsapp/tech-provider-program/setup-and-integration
https://docs.360dialog.com/docs/messaging/webhook/webhook-reference
