import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  from: vi.fn(),
  settings: [] as Array<{ verify_token: string }>,
  configs: [] as Array<{ id: string; verify_token: string | null }>,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mock.from }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => value,
  encrypt: (value: string) => value,
  isLegacyFormat: () => false,
}))

import { GET } from './webhook-processor'

beforeEach(() => {
  mock.settings = []
  mock.configs = []
  mock.from.mockImplementation((table: string) => ({
    select: () => ({
      then: (resolve: (result: { data: unknown[]; error: null }) => unknown) =>
        resolve({
          data: table === 'whatsapp_webhook_settings' ? mock.settings : mock.configs,
          error: null,
        }),
    }),
  }))
})

describe('WhatsApp webhook verification', () => {
  it('accepts a token saved before a WhatsApp number is connected', async () => {
    mock.settings = [{ verify_token: 'stored-webhook-token-123' }]

    const response = await GET(new Request(
      'https://crm.example.com/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=stored-webhook-token-123&hub.challenge=challenge',
    ))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('challenge')
  })
})
