import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mock = vi.hoisted(() => ({ requireRole: vi.fn(), query: {
  select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn(), upsert: vi.fn(),
}, admin: { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
  neq: vi.fn().mockReturnThis(), not: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(), maybeSingle: vi.fn(),
} }))
vi.mock('@/lib/auth/account', () => ({ requireRole: mock.requireRole, toErrorResponse: () => new Response(null, { status: 403 }) }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => mock.admin }) }))
import { GET, POST } from './route'

// Meta's documented shapes: numeric app/configuration IDs and a 32-char hex
// app secret. Placeholders such as "your-meta-app-secret" must be rejected.
const APP_ID = '1234567890123456'
const APP_SECRET = '0123456789abcdef0123456789abcdef'
const CONFIG_ID = '9876543210987654'

function request(body: Record<string, unknown>, origin = 'https://crm.example.com') {
  return new NextRequest('https://crm.example.com/api/whatsapp/coexistence', {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin,
      cookie: 'wacrm-coexistence-state=user-1:account-1:nonce' },
    body: JSON.stringify({ code: 'temporary-code', state: 'nonce', wabaId: '123', ...body }),
  })
}
describe('Coexistence onboarding endpoint', () => {
  beforeEach(() => {
    vi.stubEnv('META_APP_ID', APP_ID)
    vi.stubEnv('META_APP_SECRET', APP_SECRET)
    vi.stubEnv('META_EMBEDDED_SIGNUP_CONFIG_ID', CONFIG_ID)
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
  it('reuses an existing account webhook token when the environment token is absent', async () => {
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '')
    mock.query.maybeSingle.mockResolvedValue({ data: null, error: null })
    mock.admin.maybeSingle.mockResolvedValue({
      data: { verify_token: 'stored-shared-token' },
      error: null,
    })

    const response = await GET()
    const settings = await response.json()

    expect(settings.ready).toBe(true)
    expect(settings.problems).not.toContain(
      expect.stringContaining('META_WEBHOOK_VERIFY_TOKEN'),
    )
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
  it('reuses an existing account webhook token when connecting a new account without the env token', async () => {
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '')
    mock.query.maybeSingle.mockResolvedValue({ data: null, error: null })
    mock.admin.maybeSingle
      .mockResolvedValueOnce({ data: { verify_token: 'stored-shared-token' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ access_token: 'private-token' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: '456', is_on_biz_app: true, platform_type: 'CLOUD_API' }] }))
      .mockResolvedValueOnce(Response.json({ success: true }))

    const response = await POST(request({}))

    expect(response.status).toBe(200)
    expect(mock.query.upsert.mock.calls[0][0].verify_token).toBe('stored-shared-token')
  })
  it('does not overwrite the current configuration when subscription fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ access_token: 'private-token' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: '456', is_on_biz_app: true, platform_type: 'CLOUD_API' }] }))
      .mockResolvedValueOnce(Response.json({ error: 'denied' }, { status: 403 }))
    expect((await POST(request({}))).status).toBe(502)
    expect(mock.query.upsert).not.toHaveBeenCalled()
  })
  it('exchanges the code with GET on /oauth/access_token, as Meta documents', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ access_token: 'private-token' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: '456', is_on_biz_app: true, platform_type: 'CLOUD_API' }] }))
      .mockResolvedValueOnce(Response.json({ success: true }))
    expect((await POST(request({}))).status).toBe(200)
    const [exchangeUrl, exchangeInit] = vi.mocked(fetch).mock.calls[0]
    const target = new URL(String(exchangeUrl))
    expect(target.pathname.endsWith('/oauth/access_token')).toBe(true)
    expect(target.searchParams.get('client_id')).toBe(APP_ID)
    expect(target.searchParams.get('client_secret')).toBe(APP_SECRET)
    expect(target.searchParams.get('code')).toBe('temporary-code')
    expect(exchangeInit?.method).toBe('GET')
    expect(exchangeInit?.body).toBeUndefined()
    const [subscribeUrl, subscribeInit] = vi.mocked(fetch).mock.calls[2]
    expect(String(subscribeUrl)).toContain('/123/subscribed_apps')
    expect(subscribeInit?.method).toBe('POST')
  })
  it('refuses to call Meta with placeholder credentials and says which variable is wrong', async () => {
    vi.stubEnv('META_APP_SECRET', 'your-meta-app-secret')
    const settings = await (await GET()).json()
    expect(settings.ready).toBe(false)
    expect(settings.problems).toEqual([expect.stringContaining('META_APP_SECRET')])
    const response = await POST(request({}))
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain('your-meta-app-secret')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('surfaces the Meta error code and fbtrace_id instead of a generic failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      error: {
        message: 'Error validating client secret.', type: 'OAuthException',
        code: 190, fbtrace_id: 'AbCdEf123',
      },
    }, { status: 401 }))
    const response = await POST(request({}))
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error).toMatch(/credenciais/)
    expect(body.meta).toMatchObject({
      step: 'exchange_code', status: 401, code: 190, fbtrace_id: 'AbCdEf123',
    })
    expect(mock.query.upsert).not.toHaveBeenCalled()
  })
})
