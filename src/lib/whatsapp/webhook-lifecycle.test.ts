import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  selectEq: vi.fn(),
  updateEq: vi.fn(),
  insert: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'admin_audit_log') {
        return { insert: db.insert }
      }
      return {
        select: vi.fn(() => ({ eq: db.selectEq })),
        update: vi.fn((patch: Record<string, unknown>) => {
          db.updateEq(patch)
          return { eq: vi.fn().mockResolvedValue({ error: null }) }
        }),
      }
    }),
  })),
}))

import { handleAccountUpdate } from './webhook-processor'

beforeEach(() => {
  vi.clearAllMocks()
  db.selectEq.mockResolvedValue({
    data: [{ id: 'config-1', account_id: 'account-1' }],
    error: null,
  })
  db.insert.mockResolvedValue({ error: null })
})

describe('account_update lifecycle', () => {
  it('marks an offboarded coexistence number as disconnected', async () => {
    await handleAccountUpdate('partner-business-id', {
      event: 'ACCOUNT_OFFBOARDED',
      waba_info: { waba_id: 'waba-1' },
    } as never)

    expect(db.selectEq).toHaveBeenCalledWith('waba_id', 'waba-1')
    expect(db.updateEq).toHaveBeenCalledWith(expect.objectContaining({
      status: 'disconnected',
      last_connection_event: 'ACCOUNT_OFFBOARDED',
      disconnected_at: expect.any(String),
    }))
    expect(db.insert).toHaveBeenCalledWith(expect.objectContaining({
      account_id: 'account-1',
      action: 'whatsapp_account_update',
    }))
  })

  it('restores connected state on account reconnection', async () => {
    await handleAccountUpdate('waba-1', {
      event: 'ACCOUNT_RECONNECTED',
    } as never)

    expect(db.updateEq).toHaveBeenCalledWith(expect.objectContaining({
      status: 'connected',
      last_registration_error: null,
      connected_at: expect.any(String),
    }))
  })
})
