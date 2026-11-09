import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface WhatsAppWebhookEvent {
  id: string
  payload_hash: string
  payload: { object?: string; entry?: unknown[] }
  status: 'pending' | 'processing' | 'processed' | 'failed'
  attempts: number
  available_at: string
}

export function hashWebhookPayload(rawBody: string): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex')
}

/**
 * Split a Meta delivery into independently retryable changes while keeping
 * the entry ID and top-level object. An invalid or empty payload stays one
 * event so processing can log it and finish deterministically.
 */
export function splitWhatsAppWebhookPayload(
  payload: WhatsAppWebhookEvent['payload'],
): WhatsAppWebhookEvent['payload'][] {
  const split: WhatsAppWebhookEvent['payload'][] = []
  for (const rawEntry of payload.entry ?? []) {
    if (!rawEntry || typeof rawEntry !== 'object') continue
    const entry = rawEntry as Record<string, unknown>
    const changes = Array.isArray(entry.changes) ? entry.changes : []
    if (changes.length === 0) {
      split.push({ ...payload, entry: [entry] })
      continue
    }
    for (const change of changes) {
      split.push({
        ...payload,
        entry: [{ ...entry, changes: [change] }],
      })
    }
  }
  return split.length > 0 ? split : [payload]
}

/**
 * Persist a verified payload before acknowledging Meta. The unique hash
 * makes exact-signature retries idempotent.
 */
export async function enqueueWhatsAppWebhook(
  db: SupabaseClient,
  payload: WhatsAppWebhookEvent['payload'],
  dedupeSource = JSON.stringify(payload),
): Promise<{ id: string; isNew: boolean; status: WhatsAppWebhookEvent['status'] }> {
  const payloadHash = hashWebhookPayload(dedupeSource)
  const { data: inserted, error: insertError } = await db
    .from('whatsapp_webhook_events')
    .upsert(
      {
        payload_hash: payloadHash,
        payload,
        status: 'pending',
        available_at: new Date().toISOString(),
      },
      { onConflict: 'payload_hash', ignoreDuplicates: true },
    )
    .select('id, status')
    .maybeSingle()

  if (insertError) throw insertError
  if (inserted) {
    return {
      id: inserted.id as string,
      isNew: true,
      status: inserted.status as WhatsAppWebhookEvent['status'],
    }
  }

  const { data: existing, error: readError } = await db
    .from('whatsapp_webhook_events')
    .select('id, status')
    .eq('payload_hash', payloadHash)
    .maybeSingle()

  if (readError || !existing) {
    throw readError ?? new Error('Webhook event was neither inserted nor found')
  }
  return {
    id: existing.id as string,
    isNew: false,
    status: existing.status as WhatsAppWebhookEvent['status'],
  }
}

export async function processPersistedWebhookEvent(
  db: SupabaseClient,
  eventId: string,
  handler: (payload: WhatsAppWebhookEvent['payload']) => Promise<void>,
): Promise<'processed' | 'failed' | 'busy'> {
  const { data: claimedRows, error: claimError } = await db.rpc(
    'claim_whatsapp_webhook_event',
    { p_event_id: eventId },
  )
  if (claimError) throw claimError

  const claimed = Array.isArray(claimedRows) ? claimedRows[0] : claimedRows
  if (!claimed?.payload) return 'busy'

  try {
    await handler(claimed.payload as WhatsAppWebhookEvent['payload'])
    const { error } = await db
      .from('whatsapp_webhook_events')
      .update({
        status: 'processed',
        processed_at: new Date().toISOString(),
        processing_started_at: null,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', eventId)
    if (error) throw error
    return 'processed'
  } catch (error) {
    const attempts = Number(claimed.attempts ?? 1)
    const retryDelayMs = Math.min(300_000, 5_000 * 2 ** Math.max(0, attempts - 1))
    const message = error instanceof Error ? error.message : String(error)
    await db
      .from('whatsapp_webhook_events')
      .update({
        status: 'failed',
        processing_started_at: null,
        available_at: new Date(Date.now() + retryDelayMs).toISOString(),
        last_error: message.slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq('id', eventId)
    throw error
  }
}

export async function listRetryableWebhookEventIds(
  db: SupabaseClient,
  limit = 20,
): Promise<string[]> {
  const { data, error } = await db
    .from('whatsapp_webhook_events')
    .select('id')
    .or(
      `status.in.(pending,failed),and(status.eq.processing,processing_started_at.lt.${new Date(Date.now() - 10 * 60_000).toISOString()})`,
    )
    .lte('available_at', new Date().toISOString())
    .lt('attempts', 8)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw error
  return (data ?? []).map((row: { id: string }) => row.id)
}
