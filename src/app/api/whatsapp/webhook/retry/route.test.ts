import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({})),
}))
vi.mock('@/lib/whatsapp/webhook-events', () => ({
  listRetryableWebhookEventIds: vi.fn(),
  processPersistedWebhookEvent: vi.fn(),
}))
vi.mock('@/lib/whatsapp/webhook-processor', () => ({
  processWebhook: vi.fn(),
}))

import { POST } from './route'

afterEach(() => vi.unstubAllEnvs())

describe('webhook retry authorization', () => {
  it('rejects the endpoint when no retry secret is configured', async () => {
    vi.stubEnv('WHATSAPP_WEBHOOK_RETRY_SECRET', '')
    const response = await POST(new Request('https://crm.test/api/whatsapp/webhook/retry', {
      method: 'POST',
    }))
    expect(response.status).toBe(401)
  })

  it('rejects an incorrect bearer secret', async () => {
    vi.stubEnv('WHATSAPP_WEBHOOK_RETRY_SECRET', 'expected-secret')
    const response = await POST(new Request('https://crm.test/api/whatsapp/webhook/retry', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
    }))
    expect(response.status).toBe(401)
  })
})
