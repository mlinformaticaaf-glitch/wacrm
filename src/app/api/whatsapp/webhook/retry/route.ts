import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import {
  listRetryableWebhookEventIds,
  processPersistedWebhookEvent,
} from '@/lib/whatsapp/webhook-events'
import { processWebhook } from '@/lib/whatsapp/webhook-processor'

export const maxDuration = 60

function authorized(request: Request): boolean {
  const secret = process.env.WHATSAPP_WEBHOOK_RETRY_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization')
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const ids = await listRetryableWebhookEventIds(db, 20)
  let processed = 0
  let failed = 0
  let busy = 0

  for (const id of ids) {
    try {
      const outcome = await processPersistedWebhookEvent(
        db,
        id,
        (payload) => processWebhook(payload as Parameters<typeof processWebhook>[0]),
      )
      if (outcome === 'processed') processed++
      else if (outcome === 'busy') busy++
    } catch {
      failed++
    }
  }

  const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { error: cleanupError } = await db
    .from('whatsapp_webhook_events')
    .delete()
    .eq('status', 'processed')
    .lt('processed_at', retentionCutoff)
  if (cleanupError) {
    console.warn('[webhook] processed-event retention cleanup failed:', cleanupError)
  }

  return NextResponse.json(
    { processed, failed, busy, remaining: ids.length - processed - failed - busy },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
