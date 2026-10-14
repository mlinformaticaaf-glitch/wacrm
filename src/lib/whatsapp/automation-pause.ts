import type { SupabaseClient } from '@supabase/supabase-js'

/** Read at dispatch AND immediately before automated sends, including cron. */
export async function isAutomationPaused(
  db: SupabaseClient, accountId: string, conversationId: string,
): Promise<boolean> {
  const { data, error } = await db.from('conversations')
    .select('automation_paused_at').eq('account_id', accountId)
    .eq('id', conversationId).maybeSingle()
  // Fail closed: a missing conversation or an unavailable migration must
  // not allow an automated reply during a human takeover.
  return Boolean(error || !data || data.automation_paused_at)
}

export async function assertAutomationNotPaused(
  db: SupabaseClient, accountId: string, conversationId?: string | null,
) {
  if (conversationId && await isAutomationPaused(db, accountId, conversationId)) {
    throw new Error('Automation paused: human is handling this conversation')
  }
}
