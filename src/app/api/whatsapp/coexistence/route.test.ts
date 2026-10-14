import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mock = vi.hoisted(() => ({ requireRole: vi.fn(), query: {
  select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn(), upsert: vi.fn(),
}, admin: { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
  neq: vi.fn().mockReturnThis(), maybeSingle: vi.fn(),
} }))
vi.mock('@/lib/auth/account', () => ({ requireRole: mock.requireRole, toErrorResponse: () => new Response(null, { status: 403 }) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => mock.admin }) }))
import { GET, POST } from './route'

function request(body: Record<string, unknown>, origin = 'https://crm.example.com') {
  return new NextRequest('https://crm.example.com/api/whatsapp/coexistence', {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin,
      cookie: 'wacrm-coexistence-state=user-1:account-1:nonce' },
    body: JSON.stringify({ code: 'temporary-code', state: 'nonce', wabaId: '123', ...body }),
  })
}
describe('Coexistence onboarding endpoint', () => {
  beforeEach(() => {
    vi.stubEnv('META_APP_ID', 'app-1')
    vi.stubEnv('META_APP_SECRET', 'test-secret')
    vi.stubEnv('META_EMBEDDED_SIGNUP_CONFIG_ID', 'config-1')
    mock.requireRole.mockResolvedValue({ userId: 'user-1', accountId: 'account-1',
      supabase: { from: () => mock.query } })
    mock.query.maybeSingle.mockResolvedValue({ data: { id: 'cfg-1', user_id: 'user-1', verify_token: 'encrypted-verify' }, error: null })
    mock.query.upsert.mockResolvedValue({ error: null })
    mock.admin.maybeSingle.mockResolvedValue({ data: null, error: null })
    vi.stubGlobal('fetch', vi.fn())
  })
  it('requires administrator access before starting the flow', async () => {
    mock.requireRole.mockRejectedValue(new Error('Forbidden'))
    expect((await GET()).status).toBe(403)
    expect(mock.requireRole).toHaveBeenCalledWith('admin')
  })
  it('rejects an invalid nonce or origin before exchanging the code', async () => {
    expect((await POST(request({ state: 'wrong' }))).status).toBe(403)
    expect((await POST(request({}, 'https://evil.example'))).status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects an API-only number without registering or saving it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ access_token: 'private-token' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: '456', is_on_biz_app: false, platform_type: 'CLOUD_API' }] }))
    expect((await POST(request({}))).status).toBe(400)
    expect(mock.query.upsert).not.toHaveBeenCalled()
  })
  it('stores an encrypted token for a verified mobile number and never calls /register', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ access_token: 'private-token' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: '456', is_on_biz_app: true, platform_type: 'CLOUD_API' }] }))
      .mockResolvedValueOnce(Response.json({ success: true }))
    const response = await POST(request({}))
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).not.toContain('private-token')
    const saved = mock.query.upsert.mock.calls[0][0]
    expect(saved.connection_mode).toBe('coexistence')
    expect(saved.verify_token).toBe('encrypted-verify')
    expect(saved.access_token).not.toBe('private-token')
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/register'))).toBe(false)
  })
  it('does not overwrite the current configuration when subscription fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ access_token: 'private-token' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: '456', is_on_biz_app: true, platform_type: 'CLOUD_API' }] }))
      .mockResolvedValueOnce(Response.json({ error: 'denied' }, { status: 403 }))
    expect((await POST(request({}))).status).toBe(502)
    expect(mock.query.upsert).not.toHaveBeenCalled()
  })
})
