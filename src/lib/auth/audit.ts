import type { SupabaseClient } from '@supabase/supabase-js'

export async function recordAdminAudit(
  db: SupabaseClient,
  entry: {
    accountId: string
    actorUserId?: string | null
    action: string
    targetType?: string
    targetId?: string | null
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  try {
    const { error } = await db.from('admin_audit_log').insert({
      account_id: entry.accountId,
      actor_user_id: entry.actorUserId ?? null,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
    })
    if (error) {
      // Audit failure must be visible but must not disclose secrets or make
      // the primary operation appear more successful than it was.
      console.error('[audit] failed to record administrative action:', error.message)
    }
  } catch (error) {
    console.error('[audit] failed to record administrative action:', error)
  }
}
