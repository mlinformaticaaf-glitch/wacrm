/** Session messages are untrusted browser input; IDs are rechecked on Meta. */
export function parseCoexistenceSession(origin: string, raw: unknown): { wabaId: string; phoneNumberId?: string } | null {
  if (!['https://www.facebook.com', 'https://web.facebook.com'].includes(origin)) return null
  try {
    const session = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (session?.type !== 'WA_EMBEDDED_SIGNUP' ||
      session.event !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' ||
      !/^\d+$/.test(session.data?.waba_id ?? '')) return null
    const phone = session.data?.phone_number_id
    return { wabaId: session.data.waba_id,
      ...(typeof phone === 'string' && /^\d+$/.test(phone) ? { phoneNumberId: phone } : {}) }
  } catch { return null }
}

export interface CoexistencePhone {
  id: string
  is_on_biz_app?: boolean
  platform_type?: string
  display_phone_number?: string
}

export function selectCoexistencePhone(phones: CoexistencePhone[], requestedId?: string): CoexistencePhone {
  const eligible = phones.filter(p => p.is_on_biz_app === true && p.platform_type === 'CLOUD_API')
  const selected = requestedId ? eligible.find(p => p.id === requestedId) : eligible.length === 1 ? eligible[0] : undefined
  if (!selected) throw new Error('Meta did not confirm a unique number connected to both the Business app and Cloud API')
  return selected
}
