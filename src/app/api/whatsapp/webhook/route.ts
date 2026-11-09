import { NextResponse, after } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  enqueueWhatsAppWebhook,
  processPersistedWebhookEvent,
  splitWhatsAppWebhookPayload,
  type WhatsAppWebhookEvent,
} from '@/lib/whatsapp/webhook-events'
import {
  GET as verifyWebhook,
  forwardWebhookToWaml,
  processWebhook,
} from '@/lib/whatsapp/webhook-processor'

export const maxDuration = 60

let _adminClient: SupabaseClient | null = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

export async function GET(request: Request) {
  return verifyWebhook(request)
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > 2 * 1024 * 1024) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  const rawBody = await request.text()
  if (Buffer.byteLength(rawBody, 'utf8') > 2 * 1024 * 1024) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: WhatsAppWebhookEvent['payload']
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  let events: Array<Awaited<ReturnType<typeof enqueueWhatsAppWebhook>>>
  try {
    events = await Promise.all(
      splitWhatsAppWebhookPayload(body).map((part) =>
        enqueueWhatsAppWebhook(supabaseAdmin(), part),
      ),
    )
  } catch (error) {
    console.error('[webhook] failed to persist verified payload:', error)
    return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 })
  }

  const pendingEvents = events.filter((event) => event.status !== 'processed')
  if (pendingEvents.length > 0) {
    try {
      after(async () => {
        await Promise.all(pendingEvents.map((event) =>
          processPersistedWebhookEvent(
            supabaseAdmin(),
            event.id,
            (payload) => processWebhook(payload as Parameters<typeof processWebhook>[0]),
          ).catch((error) => {
            console.error('[webhook] persisted event processing failed:', error)
          }),
        ))
        await forwardWebhookToWaml(rawBody, signature)
      })
    } catch (error) {
      console.warn('[webhook] post-response scheduling unavailable:', error)
    }
  }

  return NextResponse.json(
    { status: 'received', event_ids: events.map((event) => event.id) },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
