import { randomBytes, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse, after } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { selectCoexistencePhone, type CoexistencePhone } from '@/lib/whatsapp/coexistence'
import { META_API_BASE, META_GRAPH_API_VERSION } from '@/lib/whatsapp/meta-api'
import { startCoexistenceSync } from '@/lib/whatsapp/coexistence-sync'
import { recordAdminAudit } from '@/lib/auth/audit'
import { createClient } from '@supabase/supabase-js'

const COOKIE = 'wacrm-coexistence-state'
export const maxDuration = 60

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

async function findStoredWebhookVerifyToken(accountId: string) {
  const admin = supabaseAdmin()
  const { data: accountToken, error: accountTokenError } = await admin
    .from('whatsapp_webhook_settings')
    .select('verify_token')
    .eq('account_id', accountId)
    .maybeSingle()
  if (accountTokenError) throw accountTokenError
  if (accountToken?.verify_token) {
    return { token: accountToken.verify_token, accountScoped: true }
  }

  const { data, error } = await admin
    .from('whatsapp_config')
    .select('verify_token')
    .not('verify_token', 'is', null)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return { token: data?.verify_token ?? null, accountScoped: false }
}

/**
 * Meta documents these shapes: the app ID and the Facebook Login for Business
 * configuration ID are numeric, and the app secret is 32 hexadecimal chars.
 * Checking the shape — instead of truthiness — is what stops a placeholder
 * such as `your-meta-app-secret` from being sent to Meta, where it can only
 * fail with an opaque `invalid_client`.
 */
const NUMERIC_ID = /^\d{6,32}$/
/**
 * The app secret is checked for placeholders only: Vercel stores it as
 * "sensitive" (the value cannot be read back), so its exact shape cannot be
 * asserted after the fact — and a valid secret in an unexpected shape must
 * never block a deployment that already works.
 */
const PLACEHOLDER = /your[-_ ]|seu[-_ ]|sua[-_ ]|changeme|change[-_ ]me|placeholder|example|dummy|xxxx|insira|coloque|^<|\.\.\./i

interface Credentials { appId: string; configId: string; secret: string }

function describeSecretProblem(secret: string): string | null {
  if (!secret) return 'META_APP_SECRET ausente (esperados os 32 caracteres hexadecimais do App Dashboard)'
  if (secret.length < 16 || /\s/.test(secret) || PLACEHOLDER.test(secret)) {
    return 'META_APP_SECRET ainda é um valor de exemplo (esperados os 32 caracteres hexadecimais do App Dashboard)'
  }
  return null
}

function credentials(): { values: Credentials | null; problems: string[] } {
  const appId = (process.env.META_APP_ID ?? '').trim()
  const configId = (process.env.META_EMBEDDED_SIGNUP_CONFIG_ID ?? '').trim()
  const secret = (process.env.META_APP_SECRET ?? '').trim()
  const problems: string[] = []
  if (!NUMERIC_ID.test(appId)) {
    problems.push('META_APP_ID ausente ou inválido (esperado o ID numérico do aplicativo)')
  }
  if (!NUMERIC_ID.test(configId)) {
    problems.push('META_EMBEDDED_SIGNUP_CONFIG_ID ausente ou inválido (esperado o ID numérico da configuração)')
  }
  const secretProblem = describeSecretProblem(secret)
  if (secretProblem) problems.push(secretProblem)
  if (problems.length > 0) return { values: null, problems }
  return { values: { appId, configId, secret }, problems }
}

interface MetaErrorDetail {
  message?: string
  type?: string
  code?: number
  error_subcode?: number
  error_user_title?: string
  error_user_msg?: string
  fbtrace_id?: string
}

/** A Meta reply we refuse to swallow: keeps code, subcode and fbtrace_id. */
class MetaRequestError extends Error {
  constructor(readonly status: number | null, readonly detail: MetaErrorDetail) {
    super(detail.error_user_msg || detail.message || 'Meta request failed')
    this.name = 'MetaRequestError'
  }
}

interface MetaRequestOptions {
  method?: 'GET' | 'POST'
  query?: Record<string, string>
  token?: string
}

async function metaJson(path: string, options: MetaRequestOptions = {}) {
  const url = new URL(`${META_API_BASE}/${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
  const method = options.method ?? 'GET'
  let response: Response
  try {
    response = await fetch(url, {
      method, cache: 'no-store',
      headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
      body: method === 'POST' ? new URLSearchParams() : undefined,
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    throw new MetaRequestError(null, {
      message: error instanceof Error ? error.message : 'falha de rede',
    })
  }
  const payload = (await response.json().catch(() => null)) as { error?: MetaErrorDetail } | null
  if (!response.ok || payload?.error) {
    const detail = payload?.error && typeof payload.error === 'object' ? payload.error : {}
    throw new MetaRequestError(response.status, detail)
  }
  return (payload ?? {}) as Record<string, unknown>
}

/** Turns Meta's vocabulary into an instruction the administrator can follow. */
function explainMetaFailure(detail: MetaErrorDetail, status: number | null, fallback: string) {
  const text = `${detail.message ?? ''} ${detail.error_user_msg ?? ''}`.toLowerCase()
  const trace = detail.fbtrace_id ? ` (fbtrace_id ${detail.fbtrace_id})` : ''
  if (detail.code === 190 || /invalid_client|invalid client|invalid oauth|malformed access token/.test(text)) {
    return 'A Meta recusou as credenciais do aplicativo. Confira META_APP_ID e META_APP_SECRET em App settings → Basic.'
  }
  if (/expired|already been used|has been used/.test(text)) {
    return 'O código de autorização expirou ou já foi usado (a Meta expira o código em 30 segundos). Refaça a conexão.'
  }
  if (detail.code === 200 || detail.code === 10 || /permission/.test(text)) {
    return `O aplicativo não tem permissão sobre este número. Revise whatsapp_business_management e o acesso avançado no App Review${trace}.`
  }
  const reason = (detail.error_user_msg || detail.message || '').trim()
  if (reason) return `${fallback}: ${reason}${trace}`
  return `${fallback}${status ? ` (HTTP ${status})` : ''}${trace}`
}

function metaFailure(step: string, error: MetaRequestError, fallback: string) {
  const { detail, status } = error
  // Structured log: without code/fbtrace_id the App Dashboard support ticket
  // cannot locate the request that failed.
  console.error('[coexistence] Meta request failed', {
    step, status, code: detail.code ?? null, subcode: detail.error_subcode ?? null,
    type: detail.type ?? null, message: detail.message ?? null,
    userMessage: detail.error_user_msg ?? null, fbtrace_id: detail.fbtrace_id ?? null,
  })
  return NextResponse.json({
    error: explainMetaFailure(detail, status, fallback),
    meta: {
      step, status, code: detail.code ?? null, subcode: detail.error_subcode ?? null,
      type: detail.type ?? null, fbtrace_id: detail.fbtrace_id ?? null,
    },
  }, { status: 502 })
}

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { values, problems } = credentials()
    const { data: existing, error: existingError } = await ctx.supabase
      .from('whatsapp_config')
      .select('verify_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (existingError) {
      return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
    }
    let hasVerifyToken = Boolean(existing?.verify_token || process.env.META_WEBHOOK_VERIFY_TOKEN)
    let webhookTokenConfigured = hasVerifyToken
    if (!hasVerifyToken) {
      try {
        const storedToken = await findStoredWebhookVerifyToken(ctx.accountId)
        hasVerifyToken = Boolean(storedToken.token)
        webhookTokenConfigured = storedToken.accountScoped
      } catch (error) {
        console.error('[coexistence] failed to check stored webhook verification token:', error)
        return NextResponse.json({ error: 'Failed to check webhook configuration' }, { status: 500 })
      }
    }
    if (!hasVerifyToken) {
      problems.push(
        'Nenhum token de verificação do webhook foi encontrado. Configure META_WEBHOOK_VERIFY_TOKEN no ambiente de produção ou salve o token na configuração WhatsApp antes de conectar.',
      )
    }
    const ready = values !== null && problems.length === 0
    const state = randomBytes(32).toString('hex')
    const response = NextResponse.json({
      ready, appId: values?.appId ?? '', configId: values?.configId ?? '',
      version: META_GRAPH_API_VERSION, state, problems, webhookTokenConfigured,
      message: ready ? null : `A conexão pelo celular está indisponível. ${problems.join('; ')}.`,
    }, { headers: { 'Cache-Control': 'no-store' } })
    response.cookies.set(COOKIE, `${ctx.userId}:${ctx.accountId}:${state}`, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', maxAge: 600, path: '/api/whatsapp/coexistence',
    })
    return response
  } catch (error) { return toErrorResponse(error) }
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
    const candidateWabaIds: string[] = Array.isArray(body?.wabaIds)
      ? body.wabaIds
      : typeof body?.wabaId === 'string' ? [body.wabaId] : []
    if (typeof body?.code !== 'string' || !body.code || body.code.length > 4096 ||
      candidateWabaIds.length === 0 || candidateWabaIds.length > 20 ||
      candidateWabaIds.some((id: unknown) => typeof id !== 'string' || !/^\d+$/.test(id)) ||
      (body.phoneNumberId !== undefined && (typeof body.phoneNumberId !== 'string' || !/^\d+$/.test(body.phoneNumberId)))) {
      return NextResponse.json({ error: 'Invalid signup result' }, { status: 400 })
    }
    const { values, problems } = credentials()
    if (!values) {
      return NextResponse.json({
        error: `A conexão pelo celular não está configurada: ${problems.join('; ')}.`,
        problems,
      }, { status: 503 })
    }
    const { data: existing, error: existingError } = await ctx.supabase.from('whatsapp_config')
      .select('id, user_id, verify_token').eq('account_id', ctx.accountId).maybeSingle()
    if (existingError) return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
    const admin = supabaseAdmin()
    let verifyToken = existing?.verify_token
      || (process.env.META_WEBHOOK_VERIFY_TOKEN ? encrypt(process.env.META_WEBHOOK_VERIFY_TOKEN) : null)
    if (!verifyToken) {
      try {
        verifyToken = (await findStoredWebhookVerifyToken(ctx.accountId)).token
      } catch (error) {
        console.error('[coexistence] failed to load stored webhook verification token:', error)
        return NextResponse.json({ error: 'Failed to load webhook configuration' }, { status: 500 })
      }
    }
    if (!verifyToken) return NextResponse.json({ error: 'Configure e valide o token de verificação do webhook antes de conectar o celular.' }, { status: 409 })
    let accessToken: string
    let matchedWabaId = ''
    try {
      // Meta documents GET for this exchange (not POST):
      //   GET /oauth/access_token?client_id=…&client_secret=…&code=…
      // See "Onboarding business customers as a Tech Provider", step 1.
      const exchanged = await metaJson('oauth/access_token', {
        query: { client_id: values.appId, client_secret: values.secret, code: body.code },
      })
      if (typeof exchanged.access_token !== 'string') {
        throw new MetaRequestError(200, { message: 'resposta sem access_token' })
      }
      accessToken = exchanged.access_token
      // Membership and coexistence are checked with the NEW token. A
      // forged browser postMessage cannot bind another tenant's number.
    } catch (error) {
      if (error instanceof MetaRequestError) {
        return metaFailure('exchange_code', error, 'A Meta não trocou o código de autorização')
      }
      return NextResponse.json({ error: 'A Meta não confirmou o número em coexistência. Conclua a opção de conectar o aplicativo WhatsApp Business e tente novamente.' }, { status: 400 })
    }
    let selected: CoexistencePhone | null = null
    try {
      for (const candidate of candidateWabaIds) {
        const listing = await metaJson(`${candidate}/phone_numbers`, {
          token: accessToken,
          query: { fields: 'id,is_on_biz_app,platform_type,display_phone_number', limit: '100' },
        })
        try {
          selected = selectCoexistencePhone(
            (listing.data as CoexistencePhone[] | undefined) ?? [],
            body.phoneNumberId,
          )
          matchedWabaId = candidate
          break
        } catch {
          // The phone may belong to another messaging account returned by v5.
        }
      }
    } catch (error) {
      if (error instanceof MetaRequestError) {
        return metaFailure('read_business_assets', error, 'A Meta não liberou os dados do número')
      }
      throw error
    }
    if (!selected) {
      return NextResponse.json({
        error: 'A Meta não confirmou um número elegível nos messaging accounts retornados.',
      }, { status: 400 })
    }
    const { data: claimed, error: claimError } = await admin.from('whatsapp_config').select('id')
      .eq('phone_number_id', selected.id).neq('account_id', ctx.accountId).maybeSingle()
    if (claimError || claimed) return NextResponse.json({ error: 'Número indisponível para esta conta do WACRM.' }, { status: 409 })
    // Coexistence is registered during Meta's app onboarding: NEVER call
    // /register with a PIN here, which belongs to the standard API flow.
    try { await metaJson(`${matchedWabaId}/subscribed_apps`, { method: 'POST', token: accessToken }) }
    catch (error) {
      if (error instanceof MetaRequestError) {
        return metaFailure('subscribed_apps', error, 'A Meta não confirmou a assinatura do webhook. Verifique as permissões do aplicativo')
      }
      throw error
    }
    const now = new Date().toISOString()
    const { error: saveError } = await ctx.supabase.from('whatsapp_config').upsert({
      ...(existing ? { id: existing.id } : {}), account_id: ctx.accountId,
      user_id: existing?.user_id || ctx.userId, phone_number_id: selected.id,
      waba_id: matchedWabaId, access_token: encrypt(accessToken), verify_token: verifyToken,
      connection_mode: 'coexistence', status: 'connected', connected_at: now,
      registered_at: now, subscribed_apps_at: now, last_registration_error: null,
      updated_at: now,
    }, { onConflict: 'account_id' })
    if (saveError) return NextResponse.json({
      error: 'Não foi possível salvar. Verifique se as migrações 037 e 040 foram aplicadas.',
    }, { status: 500 })
    await recordAdminAudit(admin, {
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: 'whatsapp_coexistence_connected',
      targetType: 'whatsapp_config',
      targetId: selected.id,
      metadata: {
        waba_id: matchedWabaId,
        connection_mode: 'coexistence',
      },
    })
    try {
      after(async () => {
        try {
          const sync = await startCoexistenceSync({
            db: admin,
            accountId: ctx.accountId,
            phoneNumberId: selected.id,
            accessToken,
          })
          if (sync.warnings.length > 0) {
            console.warn('[coexistence] synchronization needs attention:', sync.warnings)
          }
        } catch (error) {
          console.error('[coexistence] failed to start synchronization:', error)
        }
      })
    } catch (error) {
      // Unit tests and adapters without waitUntil can still use the explicit
      // POST /api/whatsapp/coexistence/sync retry endpoint.
      console.warn('[coexistence] background sync scheduling unavailable:', error)
    }
    const response = NextResponse.json({
      success: true,
      phone: selected.display_phone_number,
      syncScheduled: true,
    }, { headers: { 'Cache-Control': 'no-store' } })
    response.cookies.delete({ name: COOKIE, path: '/api/whatsapp/coexistence' })
    return response
  } catch (error) { return toErrorResponse(error) }
}
