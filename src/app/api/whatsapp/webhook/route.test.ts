import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  enqueue: vi.fn(),
  process: vi.fn(),
  split: vi.fn((payload: unknown) => [payload]),
  forward: vi.fn(),
  processor: vi.fn(),
  get: vi.fn(),
}))

vi.mock('@/lib/whatsapp/webhook-events', () => ({
  enqueueWhatsAppWebhook: mock.enqueue,
  processPersistedWebhookEvent: mock.process,
  splitWhatsAppWebhookPayload: mock.split,
}))
vi.mock('@/lib/whatsapp/webhook-processor', () => ({
  GET: mock.get,
  forwardWebhookToWaml: mock.forward,
  processWebhook: mock.processor,
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn() })),
}))

import { POST } from './route'

const secret = process.env.META_APP_SECRET!
const body = JSON.stringify({ entry: [] })
const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`

beforeEach(() => {
  vi.clearAllMocks()
  mock.enqueue.mockResolvedValue({
    id: 'event-1',
    isNew: true,
    status: 'pending',
  })
})

describe('WhatsApp webhook acknowledgment', () => {
  it('rejects an unsigned payload before persistence', async () => {
    const response = await POST(new Request('https://crm.test/api/whatsapp/webhook', {
      method: 'POST',
      body,
    }))
    expect(response.status).toBe(401)
    expect(mock.enqueue).not.toHaveBeenCalled()
  })

  it('persists a verified payload before acknowledging it', async () => {
    const response = await POST(new Request('https://crm.test/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': signature },
      body,
    }))
    expect(response.status).toBe(200)
    expect(mock.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      JSON.parse(body),
    )
  })

  it('asks Meta to retry when durable storage fails', async () => {
    mock.enqueue.mockRejectedValueOnce(new Error('database down'))
    const response = await POST(new Request('https://crm.test/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': signature },
      body,
    }))
    expect(response.status).toBe(503)
  })
})
