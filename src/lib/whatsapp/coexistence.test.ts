import { describe, expect, it } from 'vitest'
import {
  isWhatsAppConfigConnected,
  parseCoexistenceSession,
  selectCoexistencePhone,
} from './coexistence'

const completed = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: '123', phone_number_id: '456' } }
const completedV5 = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { messaging_account_ids: ['123'], phone_number_id: '456', is_on_biz_app: true } }
describe('Coexistence signup trust boundaries', () => {
  it('keeps an active coexistence account connected while sync is degraded', () => {
    expect(isWhatsAppConfigConnected({
      connection_mode: 'coexistence',
      status: 'degraded',
    })).toBe(true)
    expect(isWhatsAppConfigConnected({
      connection_mode: 'coexistence',
      status: 'syncing',
    })).toBe(true)
    expect(isWhatsAppConfigConnected({
      connection_mode: 'coexistence',
      status: 'disconnected',
    })).toBe(false)
    expect(isWhatsAppConfigConnected({
      connection_mode: 'cloud_api',
      status: 'degraded',
    })).toBe(false)
  })

  it('rejects forged origin and ordinary Cloud API completion', () => {
    expect(parseCoexistenceSession('https://www.facebook.com.evil.example', completed)).toBeNull()
    expect(parseCoexistenceSession('https://www.facebook.com', { ...completed, event: 'FINISH' })).toBeNull()
  })
  it('accepts the WABA-only completion sent by Business app signup', () => {
    expect(parseCoexistenceSession('https://web.facebook.com', JSON.stringify({ ...completed, data: { waba_id: '123' } }))).toEqual({ wabaIds: ['123'], wabaId: '123' })
  })
  it('accepts the Embedded Signup v5 completion event', () => {
    expect(parseCoexistenceSession('https://www.facebook.com', completedV5)).toEqual({ wabaIds: ['123'], wabaId: '123', phoneNumberId: '456' })
  })
  it('rejects v5 completion for a number outside the Business app', () => {
    expect(parseCoexistenceSession('https://www.facebook.com', {
      ...completedV5,
      data: { ...completedV5.data, is_on_biz_app: false },
    })).toBeNull()
  })
  it('rejects malformed session and nonnumeric identifiers', () => {
    expect(parseCoexistenceSession('https://www.facebook.com', '{')).toBeNull()
    expect(parseCoexistenceSession('https://www.facebook.com', { ...completed, data: { waba_id: '123/phone_numbers' } })).toBeNull()
  })
  it('never guesses between multiple eligible numbers', () => {
    const phones = ['1', '2'].map(id => ({ id, is_on_biz_app: true, platform_type: 'CLOUD_API' }))
    expect(() => selectCoexistencePhone(phones)).toThrow()
    expect(selectCoexistencePhone(phones, '2').id).toBe('2')
    expect(() => selectCoexistencePhone(phones, '3')).toThrow()
  })
  it('refuses a number detached from the mobile app', () => {
    expect(() => selectCoexistencePhone([{ id: '1', is_on_biz_app: false, platform_type: 'CLOUD_API' }], '1')).toThrow()
  })
})
