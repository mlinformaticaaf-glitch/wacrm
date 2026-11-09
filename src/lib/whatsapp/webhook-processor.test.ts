import { describe, expect, it } from 'vitest'
import {
  customerIdentity,
  dbContentType,
  isValidMessageStatusTransition,
  mapHistoryStatus,
} from './webhook-processor'

describe('webhook coexistence identity and status helpers', () => {
  it('uses the recipient for outgoing app echoes', () => {
    expect(customerIdentity({
      id: 'echo-1',
      timestamp: '1',
      type: 'text',
      from: '15550000000',
      to: '16551111111',
      to_user_id: 'US.customer',
    }, undefined, true)).toEqual({
      phone: '16551111111',
      bsuid: 'US.customer',
    })
  })

  it('accepts a BSUID-only inbound identity', () => {
    expect(customerIdentity({
      id: 'in-1',
      timestamp: '1',
      type: 'text',
      from_user_id: 'US.customer',
    })).toEqual({ bsuid: 'US.customer' })
  })

  it('never regresses delivered/read messages', () => {
    expect(isValidMessageStatusTransition('sent', 'delivered')).toBe(true)
    expect(isValidMessageStatusTransition('delivered', 'read')).toBe(true)
    expect(isValidMessageStatusTransition('read', 'sent')).toBe(false)
    expect(isValidMessageStatusTransition('delivered', 'failed')).toBe(false)
  })

  it('maps history and app-only message types to DB enums', () => {
    expect(mapHistoryStatus('READ')).toBe('read')
    expect(mapHistoryStatus('ERROR')).toBe('failed')
    expect(dbContentType('sticker')).toBe('image')
    expect(dbContentType('revoke')).toBe('text')
  })
})
