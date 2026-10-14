import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertAutomationNotPaused, isAutomationPaused } from './automation-pause'

function mockDb(data: unknown, error: unknown = null) {
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data, error }) }
  return { db: { from: vi.fn(() => query) } as unknown as SupabaseClient, query }
}
describe('Human takeover gates automated sends', () => {
  it('checks the account and conversation and blocks a paused send', async () => {
    const { db, query } = mockDb({ automation_paused_at: '2026-10-13T12:00:00Z' })
    await expect(assertAutomationNotPaused(db, 'account-1', 'conversation-1')).rejects.toThrow(/human/i)
    expect(query.eq).toHaveBeenCalledWith('account_id', 'account-1')
    expect(query.eq).toHaveBeenCalledWith('id', 'conversation-1')
  })
  it('allows sending again after explicit resume', async () => {
    const { db } = mockDb({ automation_paused_at: null })
    await expect(assertAutomationNotPaused(db, 'account-1', 'conversation-1')).resolves.toBeUndefined()
  })
  it('fails closed on a missing conversation or unavailable migration', async () => {
    expect(await isAutomationPaused(mockDb(null).db, 'a', 'c')).toBe(true)
    expect(await isAutomationPaused(mockDb(null, { message: 'column missing' }).db, 'a', 'c')).toBe(true)
  })
})
