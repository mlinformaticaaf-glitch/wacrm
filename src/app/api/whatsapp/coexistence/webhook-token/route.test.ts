import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mock = vi.hoisted(() => ({
  requireRole: vi.fn(),
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
  upsert: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mock.requireRole,
  toErrorResponse: () => new Response(null, { status: 403 }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: mock.encrypt }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: () => ({ upsert: mock.upsert }) }),
}))

import { POST } from './route'

function request(body: unknown, origin = 'https://crm.example.com') {
  return new NextRequest('https://crm.example.com/api/whatsapp/coexistence/webhook-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin },
    body: JSON.stringify(body),
  })
}

describe('standalone WhatsApp webhook token setup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.requireRole.mockResolvedValue({ accountId: 'account-1', userId: 'user-1' })
    mock.upsert.mockResolvedValue({ error: null })
  })

  it('lets only the account owner save the token without phone credentials', async () => {
    const response = await POST(request({ verifyToken: 'secure-webhook-token-123' }))

    expect(response.status).toBe(200)
    expect(mock.requireRole).toHaveBeenCalledWith('owner')
    expect(mock.encrypt).toHaveBeenCalledWith('secure-webhook-token-123')
    expect(mock.upsert).toHaveBeenCalledWith({
      account_id: 'account-1',
      verify_token: 'encrypted:secure-webhook-token-123',
      updated_by: 'user-1',
      updated_at: expect.any(String),
    }, { onConflict: 'account_id' })
    expect(JSON.stringify(await response.json())).not.toContain('secure-webhook-token-123')
  })

  it('rejects users who are not account owners', async () => {
    mock.requireRole.mockRejectedValueOnce(new Error('Forbidden'))

    expect((await POST(request({ verifyToken: 'secure-webhook-token-123' }))).status).toBe(403)
    expect(mock.upsert).not.toHaveBeenCalled()
  })

  it('rejects a foreign origin and malformed tokens', async () => {
    expect((await POST(request({ verifyToken: 'secure-webhook-token-123' }, 'https://evil.example'))).status).toBe(403)
    expect((await POST(request({ verifyToken: 'too-short' }))).status).toBe(400)
    expect(mock.upsert).not.toHaveBeenCalled()
  })

  it('does not report a database failure as a successful save', async () => {
    mock.upsert.mockResolvedValueOnce({ error: new Error('database unavailable') })

    expect((await POST(request({ verifyToken: 'secure-webhook-token-123' }))).status).toBe(500)
  })
})
