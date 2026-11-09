/** Session messages are untrusted browser input; IDs are rechecked on Meta. */
export interface CoexistenceSession {
  wabaIds: string[]
  /** Present only when the session unambiguously identifies one account. */
  wabaId?: string
  phoneNumberId?: string
}

export function parseCoexistenceSession(origin: string, raw: unknown): CoexistenceSession | null {
  if (!['https://www.facebook.com', 'https://web.facebook.com'].includes(origin)) return null
  try {
    const session = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (session?.type !== 'WA_EMBEDDED_SIGNUP' ||
      session.event !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') return null

    // v5 replaced the scalar `waba_id` with `messaging_account_ids`.
    // Keep accepting the old shape so an already-open popup can finish.
    const v5WabaIds = Array.isArray(session.data?.messaging_account_ids)
      ? [...new Set<string>(session.data.messaging_account_ids.filter(
          (id: unknown): id is string => typeof id === 'string' && /^\d+$/.test(id),
        ))]
      : []
    const legacyWabaId = typeof session.data?.waba_id === 'string' &&
      /^\d+$/.test(session.data.waba_id) ? session.data.waba_id : undefined
    const wabaIds = v5WabaIds.length > 0 ? v5WabaIds : legacyWabaId ? [legacyWabaId] : []
    if (wabaIds.length === 0) return null
    if (v5WabaIds.length > 0 && session.data?.is_on_biz_app !== true) return null

    const phone = session.data?.phone_number_id
    return { wabaIds,
      ...(wabaIds.length === 1 ? { wabaId: wabaIds[0] } : {}),
      ...(typeof phone === 'string' && /^\d+$/.test(phone) ? { phoneNumberId: phone } : {}) }
  } catch { return null }
}

export interface CoexistencePhone {
  id: string
  is_on_biz_app?: boolean
  platform_type?: string
  display_phone_number?: string
}

export function isWhatsAppConfigConnected(config: {
  connection_mode?: string | null
  status?: string | null
}): boolean {
  if (config.connection_mode !== 'coexistence') {
    return config.status === 'connected'
  }
  return ['connected', 'coexistence', 'syncing', 'degraded'].includes(config.status ?? '')
}

export function selectCoexistencePhone(phones: CoexistencePhone[], requestedId?: string): CoexistencePhone {
  const eligible = phones.filter(p => p.is_on_biz_app === true && p.platform_type === 'CLOUD_API')
  const selected = requestedId ? eligible.find(p => p.id === requestedId) : eligible.length === 1 ? eligible[0] : undefined
  if (!selected) throw new Error('Meta did not confirm a unique number connected to both the Business app and Cloud API')
  return selected
}
