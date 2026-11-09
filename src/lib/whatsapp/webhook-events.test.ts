import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hashWebhookPayload,
  listRetryableWebhookEventIds,
  processPersistedWebhookEvent,
  splitWhatsAppWebhookPayload,
} from './webhook-events'

function mockDb(options: {
  claim?: unknown[]
  retryRows?: Array<{ id: string }>
} = {}) {
  const updateEq = vi.fn().mockResolvedValue({ error: null })
  const query = {
    update: vi.fn((_patch: Record<string, unknown>) => ({ eq: updateEq })),
    select: vi.fn(() => ({
      or: vi.fn(() => ({
        lte: vi.fn(() => ({
          lt: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({ data: options.retryRows ?? [], error: null }),
            })),
          })),
        })),
      })),
    })),
  }
  const db = {
    rpc: vi.fn().mockResolvedValue({ data: options.claim ?? [], error: null }),
    from: vi.fn(() => query),
  } as unknown as SupabaseClient
  return { db, query, updateEq }
}

describe('webhook event inbox', () => {
  it('hashes the exact raw payload', () => {
    expect(hashWebhookPayload('{"a":1}')).toBe(hashWebhookPayload('{"a":1}'))
    expect(hashWebhookPayload('{"a":1}')).not.toBe(hashWebhookPayload('{"a": 1}'))
  })

  it('splits changes into independently retryable events', () => {
    const payloads = splitWhatsAppWebhookPayload({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'waba-1',
        changes: [
          { field: 'messages', value: { messages: [] } },
          { field: 'account_update', value: { event: 'ACCOUNT_RECONNECTED' } },
        ],
      }],
    })
    expect(payloads).toHaveLength(2)
    expect((payloads[0].entry?.[0] as { changes: unknown[] }).changes).toHaveLength(1)
  })

  it('claims and completes a persisted event exactly once', async () => {
    const { db, updateEq } = mockDb({
      claim: [{ payload: { entry: [] }, attempts: 1 }],
    })
    const handler = vi.fn().mockResolvedValue(undefined)

    await expect(processPersistedWebhookEvent(db, 'event-1', handler)).resolves.toBe('processed')
    expect(handler).toHaveBeenCalledWith({ entry: [] })
    expect(updateEq).toHaveBeenCalledWith('id', 'event-1')
  })

  it('records a failed attempt and schedules a retry', async () => {
    const { db, query } = mockDb({
      claim: [{ payload: { entry: [] }, attempts: 2 }],
    })

    await expect(processPersistedWebhookEvent(
      db,
      'event-2',
      async () => { throw new Error('temporary failure') },
    )).rejects.toThrow('temporary failure')

    const update = query.update.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(update.status).toBe('failed')
    expect(update.last_error).toContain('temporary failure')
    expect(update.available_at).toEqual(expect.any(String))
  })

  it('returns busy when another worker owns the event', async () => {
    const { db } = mockDb({ claim: [] })
    await expect(processPersistedWebhookEvent(db, 'event-3', vi.fn())).resolves.toBe('busy')
  })

  it('lists only retryable rows selected by the database query', async () => {
    const { db } = mockDb({ retryRows: [{ id: 'event-4' }] })
    await expect(listRetryableWebhookEventIds(db, 10)).resolves.toEqual(['event-4'])
  })
})
