import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  getUser: vi.fn(),
  profile: vi.fn(),
  message: vi.fn(),
  config: vi.fn(),
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mock.getUser },
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mock.profile }),
          }),
        }
      }
      if (table === 'messages') {
        const chain = {
          eq: () => chain,
          limit: () => chain,
          maybeSingle: mock.message,
        }
        return { select: () => chain }
      }
      return {
        select: () => ({
          eq: () => ({ single: mock.config }),
        }),
      }
    },
  })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: mock.getMediaUrl,
  downloadMedia: mock.downloadMedia,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'access-token'),
}))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mock.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mock.profile.mockResolvedValue({ data: { account_id: 'account-1' } })
})

describe('WhatsApp media tenant boundary', () => {
  it('does not fetch media that is not attached to this account', async () => {
    mock.message.mockResolvedValue({ data: null, error: null })
    const response = await GET(new Request('https://crm.test'), {
      params: Promise.resolve({ mediaId: 'media-1' }),
    })

    expect(response.status).toBe(404)
    expect(mock.getMediaUrl).not.toHaveBeenCalled()
  })

  it('serves owned media with private no-store caching', async () => {
    mock.message.mockResolvedValue({ data: { id: 'message-1' }, error: null })
    mock.config.mockResolvedValue({
      data: { access_token: 'encrypted' },
      error: null,
    })
    mock.getMediaUrl.mockResolvedValue({
      url: 'https://lookaside.example/media',
      mimeType: 'image/jpeg',
    })
    mock.downloadMedia.mockResolvedValue({
      buffer: Buffer.from('image'),
      contentType: 'image/jpeg',
    })

    const response = await GET(new Request('https://crm.test'), {
      params: Promise.resolve({ mediaId: 'media-1' }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})
