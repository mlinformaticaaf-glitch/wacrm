import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { recordAdminAudit } from '@/lib/auth/audit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { startCoexistenceSync } from '@/lib/whatsapp/coexistence-sync'

export const maxDuration = 60

export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const { data: config, error } = await ctx.supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token, connection_mode')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
    if (!config) return NextResponse.json({ error: 'WhatsApp is not configured' }, { status: 404 })
    if (config.connection_mode !== 'coexistence') {
      return NextResponse.json({ error: 'This configuration is not in coexistence mode' }, { status: 409 })
    }

    const result = await startCoexistenceSync({
      db: ctx.supabase,
      accountId: ctx.accountId,
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
    })
    if (result.warnings.length > 0) {
      console.warn('[coexistence] sync requests were rejected by Meta:', {
        accountId: ctx.accountId,
        phoneNumberId: config.phone_number_id,
        warnings: result.warnings,
      })
    }
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
    await recordAdminAudit(admin, {
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: 'whatsapp_coexistence_sync_requested',
      targetType: 'whatsapp_config',
      targetId: config.phone_number_id,
      metadata: {
        already_started: result.alreadyStarted,
        in_progress: result.inProgress,
        warning_count: result.warnings.length,
      },
    })
    return NextResponse.json(result, {
      status: result.warnings.length > 0 ? 207 : 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
