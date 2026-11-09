import { NextRequest, NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { createClient } from '@supabase/supabase-js'

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requireRole('owner')
    if (request.headers.get('origin') !== request.nextUrl.origin) {
      return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 })
    }

    const contentLength = Number(request.headers.get('content-length') ?? 0)
    if (contentLength > 4096) {
      return NextResponse.json({ error: 'Token de verificação inválido.' }, { status: 400 })
    }
    const body = await request.json().catch(() => null)
    const verifyToken = typeof body?.verifyToken === 'string' ? body.verifyToken.trim() : ''
    if (!/^[\x21-\x7E]{16,512}$/.test(verifyToken)) {
      return NextResponse.json({
        error: 'Informe um token de 16 a 512 caracteres imprimíveis, sem espaços.',
      }, { status: 400 })
    }

    const { error } = await supabaseAdmin()
      .from('whatsapp_webhook_settings')
      .upsert({
        account_id: ctx.accountId,
        verify_token: encrypt(verifyToken),
        updated_by: ctx.userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'account_id' })

    if (error) {
      console.error('[coexistence] failed to save webhook verification token:', error)
      return NextResponse.json({ error: 'Não foi possível salvar o token do webhook.' }, { status: 500 })
    }

    return NextResponse.json({ saved: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
