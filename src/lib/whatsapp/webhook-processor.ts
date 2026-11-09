import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { isAutomationPaused } from '@/lib/whatsapp/automation-pause'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { recordAdminAudit } from '@/lib/auth/audit'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface WhatsAppContact {
  profile?: { name?: string; username?: string }
  wa_id?: string
  user_id?: string
  parent_user_id?: string
}

interface WhatsAppMessage {
  to?: string
  id: string
  from?: string
  timestamp: string
  type: string
  from_user_id?: string
  from_parent_user_id?: string
  to_user_id?: string
  to_parent_user_id?: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  revoke?: { original_message_id: string }
  edit?: { original_message_id: string; message: WhatsAppMessage }
  history_context?: { status?: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}

interface HistoryThread {
  id?: string
  context?: {
    wa_id?: string
    user_id?: string
    parent_user_id?: string
  }
  messages?: WhatsAppMessage[]
}

interface HistoryChunk {
  metadata?: {
    phase?: number
    chunk_order?: number
    progress?: number
  }
  threads?: HistoryThread[]
  errors?: Array<{ code?: number; title?: string; message?: string }>
}

interface AppStateContact {
  type?: string
  action?: 'add' | 'remove'
  metadata?: { timestamp?: string }
  contact?: {
    full_name?: string
    first_name?: string
    phone_number?: string
    user_id?: string
    parent_user_id?: string
    username?: string
  }
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata?: {
        display_phone_number?: string
        phone_number_id?: string
      }
      contacts?: WhatsAppContact[]
      messages?: WhatsAppMessage[]
      message_echoes?: WhatsAppMessage[]
      history?: HistoryChunk[]
      state_sync?: AppStateContact[]
      event?: string
      waba_info?: { waba_id?: string; owner_business_id?: string }
      disconnection_info?: { reason?: string; initiated_by?: string }
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    const limit = checkRateLimit(`meta-webhook-verify:${forwardedFor || 'unknown'}`, {
      limit: 30,
      windowMs: 60_000,
    })
    if (!limit.success) return rateLimitResponse(limit)

    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    const supplied = Buffer.from(verifyToken)
    const envVerifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN
    if (envVerifyToken) {
      const expected = Buffer.from(envVerifyToken)
      if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
        return new Response(challenge, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        })
      }
    }

    const { data: webhookSettings, error: settingsError } = await supabaseAdmin()
      .from('whatsapp_webhook_settings')
      .select('verify_token')
    if (settingsError || !webhookSettings) {
      console.error('Error fetching standalone webhook settings for verification:', settingsError)
      return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
    }
    for (const setting of webhookSettings) {
      if (!setting.verify_token) continue
      try {
        const expected = Buffer.from(decrypt(setting.verify_token))
        if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
          return new Response(challenge, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          })
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        const stored = Buffer.from(decrypt(config.verify_token))
        if (stored.length === supplied.length && timingSafeEqual(stored, supplied)) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * Meta permits one webhook callback for this app. When WAML shares this app,
 * relay the untouched, Meta-signed payload so WAML can validate it and route
 * only the phone number configured in its own database.
 */
export async function forwardWebhookToWaml(rawBody: string, signature: string | null) {
  const target = process.env.WAML_WHATSAPP_WEBHOOK_URL
  if (!target || !signature) return

  try {
    const url = new URL(target)
    if (url.protocol !== 'https:') {
      console.error('[webhook] WAML_WHATSAPP_WEBHOOK_URL must use HTTPS')
      return
    }
    const allowedHosts = (process.env.WAML_WHATSAPP_WEBHOOK_ALLOWED_HOSTS ?? '')
      .split(',')
      .map(host => host.trim().toLowerCase())
      .filter(Boolean)
    if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname.toLowerCase())) {
      console.error('[webhook] WAML relay host is not allow-listed')
      return
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': signature,
      },
      body: rawBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      console.error('[webhook] WAML relay failed:', response.status)
    }
  } catch (error) {
    console.error('[webhook] WAML relay request failed:', error)
  }
}

export async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      try {
        if (isTemplateWebhookField(change.field)) {
          await handleTemplateWebhookChange(
            { field: change.field, value: change.value as unknown },
            supabaseAdmin(),
          )
          continue
        }

        const value = change.value

        if (change.field === 'account_update') {
          await handleAccountUpdate(entry.id, value)
          continue
        }
        if (change.field === 'smb_app_state_sync') {
          await handleAppStateSync(entry.id, value)
          continue
        }
        if (change.field === 'history') {
          await handleHistoryChange(entry.id, value)
          continue
        }

        if (change.field === 'smb_message_echoes') {
          const config = await loadConfigByPhoneNumberId(value.metadata?.phone_number_id)
          if (!config || config.waba_id !== entry.id) continue
          const token = decrypt(config.access_token)
          for (const message of value.message_echoes ?? []) {
            if (!message.id || !Number.isFinite(Number(message.timestamp))) continue
            const contact = value.contacts?.find(candidate =>
              (message.to_user_id && candidate.user_id === message.to_user_id) ||
              (message.to && candidate.wa_id === message.to),
            ) ?? value.contacts?.[0]
            const identity = customerIdentity(message, contact, true)
            if (!identity) {
              console.warn('[webhook] echo has no phone or BSUID identity:', message.id)
              continue
            }
            if (message.type === 'revoke' || message.type === 'edit') {
              await processEchoMutation(
                message,
                config.account_id,
                config.user_id,
                identity,
                token,
              )
              continue
            }
            await processAppMessage(
              message,
              config.account_id,
              config.user_id,
              token,
              identity,
              contact?.profile?.name,
            )
          }
          continue
        }

        if (value.statuses) {
          for (const status of value.statuses) {
            await handleStatusUpdate(status, value.metadata?.phone_number_id)
          }
        }

        if (!value.messages) continue
        const phoneNumberId = value.metadata?.phone_number_id
        if (!phoneNumberId) {
          console.warn('[webhook] messages event without phone_number_id')
          continue
        }
        const config = await loadConfigByPhoneNumberId(phoneNumberId)
        if (!config) continue

        const decryptedAccessToken = decrypt(config.access_token)
        for (let i = 0; i < value.messages.length; i++) {
          const message = value.messages[i]
          const contact = value.contacts?.[i] ?? value.contacts?.[0]
          await processMessage(
            message,
            contact,
            config.account_id,
            config.user_id,
            decryptedAccessToken,
          )
        }
      } catch (error) {
        console.error(
          `[webhook] failed processing ${change.field} for entry ${entry.id}:`,
          error,
        )
        // Let the durable webhook worker record the failure and retry.
        // Deliveries are split by change before persistence.
        throw error
      }
    }
  }
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

const MESSAGE_STATUS_LADDER = ['sending', 'sent', 'delivered', 'read'] as const

export function isValidMessageStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') return current === 'sending' || current === 'sent'
  if (current === 'failed') return false
  const currentLevel = MESSAGE_STATUS_LADDER.indexOf(
    current as (typeof MESSAGE_STATUS_LADDER)[number],
  )
  const incomingLevel = MESSAGE_STATUS_LADDER.indexOf(
    incoming as (typeof MESSAGE_STATUS_LADDER)[number],
  )
  if (incomingLevel < 0) return false
  if (currentLevel < 0) return true
  return incomingLevel > currentLevel
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}, phoneNumberId: string | undefined) {
  if (!phoneNumberId) {
    console.warn('[webhook] status update without phone_number_id; skipped')
    return
  }
  const config = await loadConfigByPhoneNumberId(phoneNumberId)
  if (!config) {
    console.warn('[webhook] status update for an unknown phone_number_id:', phoneNumberId)
    return
  }

  // Resolve rows through conversations.account_id before mutating them.
  // This keeps status delivery tenant-scoped even if Meta IDs ever repeat.
  const { data: messageRows, error: msgFetchErr } = await supabaseAdmin()
    .from('messages')
    .select('id, status, conversation_id, conversations!inner(account_id)')
    .eq('message_id', status.id)
    .eq('conversations.account_id', config.account_id)
    .neq('sender_type', 'customer')

  if (msgFetchErr) {
    console.error('Error fetching message status rows:', msgFetchErr)
  } else {
    for (const row of messageRows ?? []) {
      if (!isValidMessageStatusTransition(row.status, status.status)) continue
      const { error: msgErr } = await supabaseAdmin()
        .from('messages')
        .update({ status: status.status })
        .eq('id', row.id)
      if (msgErr) {
        console.error('Error updating message status:', msgErr)
        continue
      }
      await dispatchWebhookEvent(
        supabaseAdmin(),
        config.account_id,
        'message.status_updated',
        {
          whatsapp_message_id: status.id,
          conversation_id: row.conversation_id,
          status: status.status,
        },
      )
    }
  }

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const timestampSeconds = Number(status.timestamp)
  const tsIso = Number.isFinite(timestampSeconds)
    ? new Date(timestampSeconds * 1000).toISOString()
    : new Date().toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status, broadcasts!inner(account_id)')
    .eq('whatsapp_message_id', status.id)
    .eq('broadcasts.account_id', config.account_id)
    .limit(1)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    // Guard transitions — forward-only on the success ladder, and
    // `failed` only from pre-delivered states.
    isValidStatusTransition(recipient.status, status.status)
  ) {
    const update: Record<string, unknown> = { status: status.status }
    if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
    if (status.status === 'delivered') update.delivered_at = tsIso
    if (status.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('Error updating broadcast recipient status:', recUpdateErr)
    }
  }

}

interface ContactIdentity {
  phone?: string
  bsuid?: string
}

export function customerIdentity(
  message: WhatsAppMessage,
  contact?: WhatsAppContact,
  outgoing = false,
): ContactIdentity | null {
  const phone = normalizePhone(
    (outgoing ? message.to : message.from) ?? message.to ?? message.from ?? contact?.wa_id ?? '',
  )
  const bsuid = (outgoing ? message.to_user_id : message.from_user_id)
    ?? message.from_user_id
    ?? message.to_user_id
    ?? contact?.user_id
  if (!phone && !bsuid) return null
  return { ...(phone ? { phone } : {}), ...(bsuid ? { bsuid } : {}) }
}

async function loadConfigByPhoneNumberId(phoneNumberId?: string) {
  if (!phoneNumberId) return null
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
  if (error) {
    console.error('[webhook] failed to load WhatsApp config:', error)
    return null
  }
  if (!data || data.length === 0) {
    console.error('[webhook] no config found for phone_number_id:', phoneNumberId)
    return null
  }
  if (data.length > 1) {
    console.error('[webhook] multiple configs found for phone_number_id:', phoneNumberId)
    return null
  }
  return data[0]
}

export async function handleAccountUpdate(
  entryId: string,
  value: WhatsAppWebhookEntry['changes'][number]['value'],
) {
  const wabaId = value.waba_info?.waba_id || entryId
  const event = (value.event ?? '').toUpperCase()
  if (!event) return

  let status: 'connected' | 'disconnected' | 'degraded' = 'degraded'
  let disconnectedAt: string | null = null
  if (event === 'ACCOUNT_RECONNECTED' || event === 'PARTNER_ADDED') {
    status = 'connected'
  } else if (
    event === 'ACCOUNT_OFFBOARDED' ||
    event === 'PARTNER_REMOVED' ||
    event === 'ACCOUNT_DELETED' ||
    event === 'DISABLED_UPDATE' ||
    event === 'ACCOUNT_DISCONNECTED'
  ) {
    status = 'disconnected'
    disconnectedAt = new Date().toISOString()
  }

  const reason = [
    value.disconnection_info?.reason,
    value.disconnection_info?.initiated_by
      ? `initiated_by=${value.disconnection_info.initiated_by}`
      : null,
  ].filter(Boolean).join('; ')
  const now = new Date().toISOString()
  const { data: configs, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, account_id')
    .eq('waba_id', wabaId)
  if (configError) {
    console.error('[webhook] failed to resolve account_update tenant:', configError)
    throw configError
  }
  for (const config of configs ?? []) {
    const { error } = await supabaseAdmin()
      .from('whatsapp_config')
      .update({
        status,
        connected_at: status === 'connected' ? now : null,
        disconnected_at: disconnectedAt,
        last_connection_event: reason ? `${event}: ${reason}` : event,
        last_connection_event_at: now,
        last_registration_error: status === 'disconnected' ? (reason || event) : null,
        updated_at: now,
      })
      .eq('id', config.id)
    if (error) {
      console.error('[webhook] failed to apply account_update:', error)
      throw error
    }
    await recordAdminAudit(supabaseAdmin(), {
      accountId: config.account_id,
      action: 'whatsapp_account_update',
      targetType: 'whatsapp_config',
      targetId: config.id,
      metadata: { event, reason: reason || null, status },
    })
  }
}

export async function handleAppStateSync(
  entryId: string,
  value: WhatsAppWebhookEntry['changes'][number]['value'],
) {
  const config = await loadConfigByPhoneNumberId(value.metadata?.phone_number_id)
  if (!config || (config.waba_id && config.waba_id !== entryId)) return

  for (const state of value.state_sync ?? []) {
    if (state.type !== 'contact' || !state.contact) continue
    const identity: ContactIdentity = {
      ...(state.contact.phone_number ? { phone: normalizePhone(state.contact.phone_number) } : {}),
      ...(state.contact.user_id ? { bsuid: state.contact.user_id } : {}),
    }
    if (!identity.phone && !identity.bsuid) continue

    if (state.action === 'remove') {
      const existing = await findContactByIdentity(config.account_id, identity)
      if (existing) {
        await supabaseAdmin()
          .from('contacts')
          .update({
            app_contact_status: 'removed',
            app_contact_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
      }
      continue
    }

    const name = state.contact.full_name || state.contact.first_name || ''
    const outcome = await findOrCreateContact(
      config.account_id,
      config.user_id,
      identity.phone,
      name,
      identity.bsuid,
    )
    if (outcome) {
      await supabaseAdmin()
        .from('contacts')
        .update({
          app_contact_status: 'present',
          app_contact_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', outcome.contact.id)
    }
  }

  const { error } = await supabaseAdmin()
    .from('whatsapp_config')
    .update({
      sync_contacts_completed_at: new Date().toISOString(),
      sync_last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', config.account_id)
  if (error) console.error('[webhook] failed to persist contact sync completion:', error)
}

export function mapHistoryStatus(raw?: string): string {
  switch ((raw ?? '').toUpperCase()) {
    case 'PLAYED':
    case 'READ':
      return 'read'
    case 'DELIVERED':
      return 'delivered'
    case 'SENT':
      return 'sent'
    case 'PENDING':
      return 'sending'
    case 'ERROR':
      return 'failed'
    default:
      return 'delivered'
  }
}

export async function handleHistoryChange(
  entryId: string,
  value: WhatsAppWebhookEntry['changes'][number]['value'],
) {
  const config = await loadConfigByPhoneNumberId(value.metadata?.phone_number_id)
  if (!config || (config.waba_id && config.waba_id !== entryId)) return
  const token = decrypt(config.access_token)

  for (const chunk of value.history ?? []) {
    if (chunk.errors?.length) {
      const message = chunk.errors
        .map(item => item.message || item.title || `error ${item.code ?? 'unknown'}`)
        .join('; ')
      await supabaseAdmin()
        .from('whatsapp_config')
        .update({
          sync_last_error: message.slice(0, 2000),
          sync_history_completed_at: new Date().toISOString(),
          status: 'connected',
          last_connection_event: 'HISTORY_SYNC_DECLINED',
          last_connection_event_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', config.account_id)
      continue
    }

    for (const thread of chunk.threads ?? []) {
      const threadIdentity: ContactIdentity = {
        ...(thread.context?.wa_id || thread.id
          ? { phone: normalizePhone(thread.context?.wa_id ?? thread.id ?? '') }
          : {}),
        ...(thread.context?.user_id ? { bsuid: thread.context.user_id } : {}),
      }
      for (const message of thread.messages ?? []) {
        await importHistoryMessage(
          config,
          message,
          token,
          threadIdentity,
          value.metadata?.display_phone_number,
        )
      }
    }

    const progress = Number(chunk.metadata?.progress)
    if (Number.isFinite(progress)) {
      const completed = progress >= 100
      const { error } = await supabaseAdmin()
        .from('whatsapp_config')
        .update({
          sync_history_progress: Math.max(0, Math.min(100, Math.round(progress))),
          sync_history_completed_at: completed ? new Date().toISOString() : null,
          status: completed ? 'connected' : 'syncing',
          sync_last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', config.account_id)
      if (error) console.error('[webhook] failed to persist history progress:', error)
    }
  }

  // Media details arrive in a follow-up history webhook under `messages`.
  for (const message of value.messages ?? []) {
    await importHistoryMessage(config, message, token, undefined, value.metadata?.display_phone_number)
  }
}

async function importHistoryMessage(
  config: Record<string, unknown>,
  message: WhatsAppMessage,
  token: string,
  threadIdentity?: ContactIdentity,
  businessPhone?: string,
) {
  const accountId = config.account_id as string
  const ownerId = config.user_id as string
  const isBusinessSender =
    Boolean(message.from) &&
    normalizePhone(message.from ?? '') === normalizePhone(businessPhone ?? '')
  const identity = threadIdentity ?? customerIdentity(message, undefined, isBusinessSender)
  if (!identity || !message.id || !Number.isFinite(Number(message.timestamp))) return

  const outcome = await findOrCreateContact(
    accountId,
    ownerId,
    identity.phone,
    '',
    identity.bsuid,
  )
  if (!outcome) return
  const conversation = await findOrCreateConversation(accountId, ownerId, outcome.contact.id)
  if (!conversation) return

  const parsed = await parseMessageContent(message, token)
  const allowed = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = allowed.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'
      : 'text'
  const senderType =
    message.from_user_id || (
      message.from && normalizePhone(message.from) !== normalizePhone(businessPhone ?? '')
    )
      ? 'customer'
      : 'agent'

  const replyId = message.context?.id
    ? await lookupInternalIdByMetaId(message.context.id, conversation.conversation.id)
    : null
  const { error } = await supabaseAdmin().rpc('record_whatsapp_message', {
    p_account_id: accountId,
    p_conversation_id: conversation.conversation.id,
    p_contact_id: outcome.contact.id,
    p_sender_type: senderType,
    p_content_type: contentType,
    p_content_text: parsed.contentText ?? (message.type === 'media_placeholder'
      ? '[Mídia histórica]'
      : null),
    p_media_url: parsed.mediaUrl,
    p_template_name: null,
    p_message_id: message.id,
    p_status: mapHistoryStatus(message.history_context?.status),
    p_created_at: new Date(Number(message.timestamp) * 1000).toISOString(),
    p_reply_to_message_id: replyId,
    p_interactive_reply_id: parsed.interactiveReplyId,
    p_from_user_id: message.from_user_id ?? (senderType === 'customer' ? identity.bsuid ?? null : null),
    p_to_user_id: message.to_user_id ?? (senderType === 'agent' ? identity.bsuid ?? null : null),
    p_increment_unread: false,
    p_source: 'whatsapp_history',
  })
  if (error) console.error('[webhook] failed to import history message:', error)
}

async function processEchoMutation(
  message: WhatsAppMessage,
  accountId: string,
  ownerId: string,
  identity: ContactIdentity,
  token: string,
) {
  const outcome = await findOrCreateContact(
    accountId,
    ownerId,
    identity.phone,
    '',
    identity.bsuid,
  )
  if (!outcome) return
  const conversation = await findOrCreateConversation(accountId, ownerId, outcome.contact.id)
  if (!conversation) return

  const originalId = message.revoke?.original_message_id ?? message.edit?.original_message_id
  if (!originalId) return
  const original = await lookupInternalIdByMetaId(originalId, conversation.conversation.id)
  if (!original) {
    console.warn('[webhook] echo mutation target not found:', originalId)
    return
  }

  if (message.type === 'revoke') {
    const { error } = await supabaseAdmin()
      .from('messages')
      .update({
        content_type: 'text',
        content_text: '[Mensagem apagada]',
        media_url: null,
        interactive_payload: null,
      })
      .eq('id', original)
      .eq('conversation_id', conversation.conversation.id)
    if (error) throw error
    return
  }

  const edited = message.edit?.message
  if (!edited) return
  const parsed = await parseMessageContent(edited, token)
  const allowed = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = allowed.has(edited.type)
    ? edited.type
    : edited.type === 'sticker'
      ? 'image'
      : 'text'
  const { error } = await supabaseAdmin()
    .from('messages')
    .update({
      content_type: contentType,
      content_text: parsed.contentText,
      media_url: parsed.mediaUrl,
    })
    .eq('id', original)
    .eq('conversation_id', conversation.conversation.id)
  if (error) throw error
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast.
 *
 * Runs on a best-effort basis — failures here must not break the
 * main inbound-message flow, so errors are swallowed with a log.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    // Most recent outbound broadcast in this account that hasn't
    // been replied to yet. Account-scoped so a shared inbox reply
    // marks the broadcast as replied regardless of which teammate
    // sent it.
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

export function dbContentType(type: string): string {
  const allowed = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  if (allowed.has(type)) return type
  if (type === 'sticker') return 'image'
  return 'text'
}

async function processAppMessage(
  message: WhatsAppMessage,
  accountId: string,
  ownerId: string,
  token: string,
  identity: ContactIdentity,
  contactName = '',
) {
  const types = new Set(['text', 'image', 'video', 'audio', 'document', 'sticker', 'location'])
  if (!types.has(message.type)) return
  const outcome = await findOrCreateContact(
    accountId,
    ownerId,
    identity.phone,
    contactName,
    identity.bsuid,
  )
  if (!outcome) return
  const conv = await findOrCreateConversation(accountId, ownerId, outcome.contact.id)
  if (!conv) return
  const { contentText, mediaUrl } = await parseMessageContent(message, token)
  const replyId = message.context?.id
    ? await lookupInternalIdByMetaId(message.context.id, conv.conversation.id) : null
  const { error } = await supabaseAdmin().rpc('record_whatsapp_app_message_v2', {
    p_account_id: accountId, p_conversation_id: conv.conversation.id,
    p_contact_id: outcome.contact.id, p_message_id: message.id,
    p_created_at: new Date(Number(message.timestamp) * 1000).toISOString(),
    p_content_type: dbContentType(message.type),
    p_content_text: contentText, p_media_url: mediaUrl,
    p_reply_to_message_id: replyId,
    p_from_user_id: message.from_user_id ?? null,
    p_to_user_id: message.to_user_id ?? identity.bsuid ?? null,
  })
  if (error) throw new Error('Failed to persist WhatsApp Business app message')
}

async function processMessage(
  message: WhatsAppMessage,
  contact: WhatsAppContact | undefined,
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string
) {
  const identity = customerIdentity(message, contact)
  if (!identity) {
    console.warn('[webhook] inbound message has no phone or BSUID identity:', message.id)
    return
  }
  const contactName = contact?.profile?.name ?? ''

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    identity.phone,
    contactName,
    identity.bsuid,
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Emit conversation.created as soon as the thread is opened — BEFORE
  // the reaction short-circuit below — so a conversation first opened by
  // a reaction still fires the event, and a subscriber always sees the
  // thread open before its first message.received.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  if (!Number.isFinite(Number(message.timestamp))) {
    console.warn('[webhook] inbound message has an invalid timestamp:', message.id)
    return
  }

  // Avoid needless media downloads for a duplicate. The RPC below remains
  // the atomic idempotency boundary.
  const { data: duplicate } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', message.id)
    .maybeSingle()
  if (duplicate) return

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken)

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  // `mediaType` is intentionally unused — the schema has no media_type
  // column; the MIME type is only used to construct the proxy URL during
  // parseMessageContent. Silence the unused-var warning:
  void mediaType

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const contentType = dbContentType(message.type)

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { data: inserted, error: insertError } = await supabaseAdmin().rpc(
    'record_whatsapp_message',
    {
      p_account_id: accountId,
      p_conversation_id: conversation.id,
      p_contact_id: contactRecord.id,
      p_sender_type: 'customer',
      p_content_type: contentType,
      p_content_text: contentText,
      p_media_url: mediaUrl,
      p_template_name: null,
      p_message_id: message.id,
      p_status: 'delivered',
      p_created_at: new Date(Number(message.timestamp) * 1000).toISOString(),
      p_reply_to_message_id: replyToInternalId,
      p_interactive_reply_id: interactiveReplyId,
      p_from_user_id: message.from_user_id ?? identity.bsuid ?? null,
      p_to_user_id: message.to_user_id ?? null,
      p_increment_unread: true,
      p_source: 'crm',
    },
  )

  if (insertError) {
    console.error('Error inserting message:', insertError)
    return
  }
  if (!inserted?.inserted) return

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances (via the aggregate
  // trigger installed in migration 003).
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  // ============================================================
  const automationPaused = await isAutomationPaused(supabaseAdmin(), accountId, conversation.id)
  const flowResult = automationPaused ? { consumed: true } : await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: contentText ?? '',
            meta_message_id: message.id,
          }
        : {
            kind: 'text',
            text: contentText ?? message.text?.body ?? '',
            meta_message_id: message.id,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    // Interactive tap → fire the interactive_reply trigger too (only
    // meaningful when a button/list reply actually arrived). Enables
    // automation-only chained menus; when a Flow owns the menu it will
    // have consumed the reply and this is skipped.
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (!automationPaused && contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (!automationPaused && isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  // Awaited — not fire-and-forget. We're inside the route's `after()`
  // block, which only keeps the function alive for promises it can see, so
  // a detached dispatch can be frozen part-way through: the log row is
  // inserted, then the steps never run. That is issue #301's failure mode
  // recurring one level down, and it's what issue #409 reported as runs
  // logging zero steps. `runAutomationsForTrigger` owns its own try/catch
  // and never throws; the `.catch` is belt-and-braces so one trigger
  // type's failure can't skip the rest of the loop.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        // Only set on interactive taps; drives the interactive_reply
        // trigger's exact-id match.
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // AI auto-reply. Runs only for plain-text inbound the deterministic
  // flow runner did NOT consume (flows win over the LLM), and only when
  // the account has enabled it. Awaited inside `after()` (same reason as
  // the webhook dispatch below); `dispatchInboundToAiReply` owns its
  // eligibility gates + try/catch and never throws.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  // message.received webhook (public API). Awaited — not fire-and-forget
  // — because we're inside the route's `after()` block, which only keeps
  // the function alive for promises it can see; a detached promise could
  // be frozen before it delivers. `dispatchWebhookEvent` early-exits
  // when the account has no matching endpoint and never throws.
  // (conversation.created is emitted earlier, right after the thread is
  // opened.)
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
  })
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string | undefined,
  name: string,
  bsuid?: string,
): Promise<ContactOutcome | null> {
  if (!phone && !bsuid) return null

  const existingContact = await findContactByIdentity(accountId, { phone, bsuid })

  if (existingContact) {
    const patch: Record<string, unknown> = {}
    if (name && name !== existingContact.name) patch.name = name
    if (bsuid && !existingContact.bsuid) patch.bsuid = bsuid
    if (phone && !existingContact.phone) patch.phone = phone
    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString()
      const { error: updateError } = await supabaseAdmin()
        .from('contacts')
        .update(patch)
        .eq('id', existingContact.id)
      if (updateError && !isUniqueViolation(updateError)) {
        console.error('[webhook] failed to enrich contact identity:', updateError)
      }
    }
    return { contact: { ...existingContact, ...patch }, wasCreated: false }
  }

  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: phone || '',
      name: name || phone || `Contato ${bsuid?.slice(-8) ?? 'WhatsApp'}`,
      ...(bsuid ? { bsuid } : {}),
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findContactByIdentity(accountId, { phone, bsuid })
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findContactByIdentity(
  accountId: string,
  identity: ContactIdentity,
): Promise<ContactRow | null> {
  if (identity.bsuid) {
    const { data, error } = await supabaseAdmin()
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .eq('bsuid', identity.bsuid)
      .maybeSingle()
    if (!error && data) return data
    if (error) console.error('[webhook] BSUID contact lookup failed:', error)
  }
  if (identity.phone) {
    return findExistingContact(supabaseAdmin(), accountId, identity.phone)
  }
  return null
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      status: 'pending',
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
