import { randomBytes, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { selectCoexistencePhone, type CoexistencePhone } from '@/lib/whatsapp/coexistence'
import { createClient } from '@supabase/supabase-js'

const COOKIE = 'wacrm-coexistence-state'
const version = process.env.META_GRAPH_API_VERSION || 'v25.0'
const graph = `https://graph.facebook.com/${version}`
export const maxDuration = 60

function settings() {
  return {
    appId: process.env.META_APP_ID,
    configId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID,
    secret: process.env.META_APP_SECRET,
  }
}

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { appId, configId, secret } = settings()
    const ready = Boolean(appId && configId && secret)
    const state = randomBytes(32).toString('hex')
    const response = NextResponse.json({ ready, appId, configId, version, state,
      message: ready ? null : 'Configure META_APP_ID, META_APP_SECRET e META_EMBEDDED_SIGNUP_CONFIG_ID para habilitar a conexão pelo celular.' },
      { headers: { 'Cache-Control': 'no-store' } })
    response.cookies.set(COOKIE, `${ctx.userId}:${ctx.accountId}:${state}`, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', maxAge: 600, path: '/api/whatsapp/coexistence',
    })
    return response
  } catch (error) { return toErrorResponse(error) }
}

async function metaJson(path: string, token?: string, body?: URLSearchParams) {
  const response = await fetch(`${graph}/${path}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body, signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error('Meta connection failed')
  return response.json()
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requireRole('admin')
    if (request.headers.get('origin') !== request.nextUrl.origin) {
      return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
    }
    const body = await request.json().catch(() => null)
    const cookie = request.cookies.get(COOKIE)?.value ?? ''
    const expected = `${ctx.userId}:${ctx.accountId}:${body?.state ?? ''}`
    const cookieBytes = Buffer.from(cookie)
    const expectedBytes = Buffer.from(expected)
    if (cookieBytes.length !== expectedBytes.length || !timingSafeEqual(cookieBytes, expectedBytes)) {
      return NextResponse.json({ error: 'A conexão expirou. Reabra o cadastro da Meta.' }, { status: 403 })
    }
    if (typeof body?.code !== 'string' || !body.code || body.code.length > 4096 ||
      typeof body.wabaId !== 'string' || !/^\d+$/.test(body.wabaId) ||
      (body.phoneNumberId !== undefined && (typeof body.phoneNumberId !== 'string' || !/^\d+$/.test(body.phoneNumberId)))) {
      return NextResponse.json({ error: 'Invalid signup result' }, { status: 400 })
    }
    const { appId, configId, secret } = settings()
    if (!appId || !configId || !secret) return NextResponse.json({ error: 'Embedded Signup is not configured' }, { status: 503 })
    const { data: existing, error: existingError } = await ctx.supabase.from('whatsapp_config')
      .select('id, user_id, verify_token').eq('account_id', ctx.accountId).maybeSingle()
    if (existingError) return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
    const verifyToken = existing?.verify_token || (process.env.META_WEBHOOK_VERIFY_TOKEN ? encrypt(process.env.META_WEBHOOK_VERIFY_TOKEN) : null)
    if (!verifyToken) return NextResponse.json({ error: 'Configure e valide o token de verificação do webhook antes de conectar o celular.' }, { status: 409 })
    let accessToken: string
    let phone: CoexistencePhone
    try {
      const exchanged = await metaJson('oauth/access_token', undefined, new URLSearchParams({
        client_id: appId, client_secret: secret, code: body.code,
      }))
      if (typeof exchanged.access_token !== 'string') throw new Error('Missing token')
      accessToken = exchanged.access_token
      // Membership and coexistence are checked with the NEW token. A
      // forged browser postMessage cannot bind another tenant's number.
      const listing = await metaJson(`${body.wabaId}/phone_numbers?fields=id,is_on_biz_app,platform_type,display_phone_number&limit=100`, accessToken)
      phone = selectCoexistencePhone(listing.data ?? [], body.phoneNumberId)
    } catch {
      return NextResponse.json({ error: 'A Meta não confirmou o número em coexistência. Conclua a opção de conectar o aplicativo WhatsApp Business e tente novamente.' }, { status: 400 })
    }
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: claimed, error: claimError } = await admin.from('whatsapp_config').select('id')
      .eq('phone_number_id', phone.id).neq('account_id', ctx.accountId).maybeSingle()
    if (claimError || claimed) return NextResponse.json({ error: 'Número indisponível para esta conta do WACRM.' }, { status: 409 })
    // Coexistence is registered during Meta's app onboarding: NEVER call
    // /register with a PIN here, which belongs to the standard API flow.
    try { await metaJson(`${body.wabaId}/subscribed_apps`, accessToken, new URLSearchParams()) }
    catch { return NextResponse.json({ error: 'A Meta não confirmou a assinatura do webhook. Verifique as permissões do aplicativo.' }, { status: 502 }) }
    const now = new Date().toISOString()
    const { error: saveError } = await ctx.supabase.from('whatsapp_config').upsert({
      ...(existing ? { id: existing.id } : {}), account_id: ctx.accountId,
      user_id: existing?.user_id || ctx.userId, phone_number_id: phone.id,
      waba_id: body.wabaId, access_token: encrypt(accessToken), verify_token: verifyToken,
      connection_mode: 'coexistence', status: 'connected', connected_at: now,
      registered_at: now, subscribed_apps_at: now, last_registration_error: null,
      updated_at: now,
    }, { onConflict: 'account_id' })
    if (saveError) return NextResponse.json({ error: 'Não foi possível salvar. Verifique se a migração 037 foi aplicada.' }, { status: 500 })
    const response = NextResponse.json({ success: true, phone: phone.display_phone_number }, { headers: { 'Cache-Control': 'no-store' } })
    response.cookies.delete({ name: COOKIE, path: '/api/whatsapp/coexistence' })
    return response
  } catch (error) { return toErrorResponse(error) }
}
