import { afterEach, describe, expect, it, vi } from 'vitest';
import { META_GRAPH_API_VERSION, requestSMBAppDataSync } from './meta-api';

afterEach(() => vi.unstubAllGlobals());

describe('requestSMBAppDataSync', () => {
  it('uses the unified Graph version and documented payload', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ request_id: 'request-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      requestSMBAppDataSync({
        phoneNumberId: 'phone-1',
        accessToken: 'secret-token',
        syncType: 'history',
      })
    ).resolves.toBe('request-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/phone-1/smb_app_data`
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      sync_type: 'history',
    });
  });

  it('surfaces the Meta error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: { message: 'History sync is unavailable' },
          },
          { status: 400 }
        )
      )
    );

    await expect(
      requestSMBAppDataSync({
        phoneNumberId: 'phone-1',
        accessToken: 'token',
        syncType: 'history',
      })
    ).rejects.toMatchObject({
      message: 'History sync is unavailable',
      retrySafe: true,
      meta: { status: 400 },
    });
  });

  it('preserves Meta error details and trace id for support diagnostics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              message: '(#135000) Generic user error',
              code: 135000,
              error_data: { details: 'The request could not be completed.' },
              fbtrace_id: 'trace-sync-123',
            },
          },
          { status: 400 }
        )
      )
    );

    await expect(
      requestSMBAppDataSync({
        phoneNumberId: 'phone-1',
        accessToken: 'token',
        syncType: 'history',
      })
    ).rejects.toMatchObject({
      message: '(#135000) Generic user error',
      retrySafe: true,
      meta: {
        status: 400,
        code: 135000,
        details: 'The request could not be completed.',
        fbtraceId: 'trace-sync-123',
      },
    });
  });

  it('does not silently accept a successful response without a request id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));

    await expect(
      requestSMBAppDataSync({
        phoneNumberId: 'phone-1',
        accessToken: 'token',
        syncType: 'history',
      })
    ).rejects.toMatchObject({ retrySafe: false });
  });
});
