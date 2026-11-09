import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const meta = vi.hoisted(() => ({
  requestSMBAppDataSync: vi.fn(),
  SMBAppSyncRequestError: class SMBAppSyncRequestError extends Error {
    constructor(
      message: string,
      readonly retrySafe: boolean,
      readonly meta?: {
        status: number
        code?: number
        subcode?: number
        details?: string
        fbtraceId?: string
      },
    ) {
      super(message);
      this.name = 'SMBAppSyncRequestError';
    }
  },
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  requestSMBAppDataSync: meta.requestSMBAppDataSync,
  SMBAppSyncRequestError: meta.SMBAppSyncRequestError,
}));

import { startCoexistenceSync } from './coexistence-sync';

function mockDb(config: Record<string, unknown>) {
  const state: Record<string, unknown> = {
    account_id: 'account-1',
    phone_number_id: 'phone-1',
    ...config,
    id: 'config-1',
  };
  const matches = (filters: Array<[string, string, unknown]>) =>
    filters.every(([operation, key, value]) => {
      if (operation === 'eq') return state[key] === value;
      return state[key] === null || state[key] === undefined;
    });
  const query = (patch?: Record<string, unknown>) => {
    const filters: Array<[string, string, unknown]> = [];
    const builder = {
      eq(key: string, value: unknown) {
        filters.push(['eq', key, value]);
        return builder;
      },
      is(key: string, value: unknown) {
        filters.push(['is', key, value]);
        return builder;
      },
      select: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => {
        if (!matches(filters)) return { data: null, error: null };
        if (patch) Object.assign(state, patch);
        return { data: patch ? { id: state.id } : { ...state }, error: null };
      }),
    };
    return builder;
  };
  const db = {
    from: vi.fn(() => ({
      select: vi.fn(() => query()),
      update: vi.fn((patch: Record<string, unknown>) => query(patch)),
    })),
  } as unknown as SupabaseClient;
  return { db, state };
}

describe('startCoexistenceSync', () => {
  beforeEach(() => {
    meta.requestSMBAppDataSync.mockReset();
    meta.requestSMBAppDataSync
      .mockResolvedValueOnce('contacts-request')
      .mockResolvedValueOnce('history-request');
  });

  it('requests both one-shot streams', async () => {
    const { db, state } = mockDb({
      sync_contacts_request_id: null,
      sync_history_request_id: null,
    });
    await expect(
      startCoexistenceSync({
        db,
        accountId: 'account-1',
        phoneNumberId: 'phone-1',
        accessToken: 'token',
      })
    ).resolves.toEqual({
      started: true,
      alreadyStarted: false,
      inProgress: false,
      warnings: [],
    });
    expect(meta.requestSMBAppDataSync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        syncType: 'smb_app_state_sync',
      })
    );
    expect(meta.requestSMBAppDataSync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        syncType: 'history',
      })
    );
  });

  it('does not call Meta again when both streams were already requested', async () => {
    const { db } = mockDb({
      sync_contacts_request_id: 'contacts-request',
      sync_history_request_id: 'history-request',
    });
    await expect(
      startCoexistenceSync({
        db,
        accountId: 'account-1',
        phoneNumberId: 'phone-1',
        accessToken: 'token',
      })
    ).resolves.toEqual({
      started: false,
      alreadyStarted: true,
      inProgress: false,
      warnings: [],
    });
    expect(meta.requestSMBAppDataSync).not.toHaveBeenCalled();
  });

  it('keeps the connection but reports partial sync failure', async () => {
    meta.requestSMBAppDataSync
      .mockReset()
      .mockRejectedValueOnce(
        new meta.SMBAppSyncRequestError('contacts unavailable', true)
      )
      .mockResolvedValueOnce('history-request');
    const { db, state } = mockDb({
      sync_contacts_request_id: null,
      sync_history_request_id: null,
    });

    const result = await startCoexistenceSync({
      db,
      accountId: 'account-1',
      phoneNumberId: 'phone-1',
      accessToken: 'token',
    });
    expect(result.started).toBe(true);
    expect(result.warnings[0]).toContain('contacts unavailable');
    expect(state.sync_contacts_claim_id).toBeNull();
  });

  it('includes Meta details and fbtrace id in the sync warning', async () => {
    meta.requestSMBAppDataSync
      .mockReset()
      .mockRejectedValueOnce(
        new meta.SMBAppSyncRequestError('(#135000) Generic user error', true, {
          status: 400,
          code: 135000,
          details: 'The request could not be completed.',
          fbtraceId: 'trace-sync-123',
        })
      )
      .mockResolvedValueOnce('history-request');
    const { db } = mockDb({
      sync_contacts_request_id: null,
      sync_history_request_id: null,
    });

    const result = await startCoexistenceSync({
      db,
      accountId: 'account-1',
      phoneNumberId: 'phone-1',
      accessToken: 'token',
    });

    expect(result.warnings[0]).toContain('The request could not be completed.')
    expect(result.warnings[0]).toContain('fbtrace_id trace-sync-123')
  })

  it('uses atomic claims so concurrent calls request each one-shot stream once', async () => {
    const { db } = mockDb({
      sync_contacts_request_id: null,
      sync_history_request_id: null,
      sync_contacts_claim_id: null,
      sync_contacts_claimed_at: null,
      sync_history_claim_id: null,
      sync_history_claimed_at: null,
    });
    const args = {
      db,
      accountId: 'account-1',
      phoneNumberId: 'phone-1',
      accessToken: 'token',
    };

    const results = await Promise.all([
      startCoexistenceSync(args),
      startCoexistenceSync(args),
    ]);

    expect(meta.requestSMBAppDataSync).toHaveBeenCalledTimes(2);
    expect(
      meta.requestSMBAppDataSync.mock.calls
        .map(([call]) => call.syncType)
        .sort()
    ).toEqual(['history', 'smb_app_state_sync']);
    expect(
      results.every(
        (result) => result.alreadyStarted || result.started || result.inProgress
      )
    ).toBe(true);
  });

  it('reports an existing claim as in progress without calling Meta', async () => {
    const { db } = mockDb({
      sync_contacts_request_id: null,
      sync_history_request_id: 'history-request',
      sync_contacts_claim_id: 'active-claim',
      sync_contacts_claimed_at: '2026-11-09T12:00:00.000Z',
      sync_history_claim_id: null,
      sync_history_claimed_at: null,
    });

    await expect(
      startCoexistenceSync({
        db,
        accountId: 'account-1',
        phoneNumberId: 'phone-1',
        accessToken: 'token',
      })
    ).resolves.toMatchObject({ started: false, inProgress: true });
    expect(meta.requestSMBAppDataSync).not.toHaveBeenCalled();
  });

  it('keeps the claim when Meta may have accepted a request but its response is ambiguous', async () => {
    const { db, state } = mockDb({
      sync_contacts_request_id: null,
      sync_history_request_id: 'history-request',
      sync_contacts_claim_id: null,
      sync_contacts_claimed_at: null,
      sync_history_claim_id: null,
      sync_history_claimed_at: null,
    });
    meta.requestSMBAppDataSync
      .mockReset()
      .mockRejectedValueOnce(
        new meta.SMBAppSyncRequestError('network timeout', false)
      );

    const result = await startCoexistenceSync({
      db,
      accountId: 'account-1',
      phoneNumberId: 'phone-1',
      accessToken: 'token',
    });

    expect(result.inProgress).toBe(true);
    expect(state.sync_contacts_claim_id).toBeTruthy();
    expect(state.sync_contacts_claimed_at).toBeTruthy();
  });
});
