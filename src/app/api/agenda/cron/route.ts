import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET ?? process.env.AUTOMATION_CRON_SECRET;
  if (!expected) return false;
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const supplied = bearer ?? request.headers.get('x-cron-secret') ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const { data: due, error } = await admin
    .from('scheduled_messages')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let sent = 0;
  let failed = 0;
  for (const scheduled of due ?? []) {
    const { data: claim } = await admin
      .from('scheduled_messages')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', scheduled.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (!claim) continue;

    try {
      let { data: conversation } = await admin
        .from('conversations')
        .select('id')
        .eq('account_id', scheduled.account_id)
        .eq('contact_id', scheduled.contact_id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!conversation) {
        const created = await admin
          .from('conversations')
          .insert({
            account_id: scheduled.account_id,
            user_id: scheduled.user_id,
            contact_id: scheduled.contact_id,
            status: 'open',
          })
          .select('id')
          .single();
        if (created.error || !created.data) {
          throw new Error(created.error?.message ?? 'Could not create conversation');
        }
        conversation = created.data;
      }

      const result = await sendMessageToConversation(admin, scheduled.account_id, {
        conversationId: conversation.id,
        messageType: scheduled.message_type,
        contentText: scheduled.content_text,
        templateName: scheduled.template_name,
        templateLanguage: scheduled.template_language,
      });

      await admin
        .from('scheduled_messages')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: result.whatsappMessageId,
          attempts: scheduled.attempts + 1,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', scheduled.id);
      sent++;
    } catch (sendError) {
      const attempts = scheduled.attempts + 1;
      const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
      await admin
        .from('scheduled_messages')
        .update({
          status: attempts >= 3 ? 'failed' : 'pending',
          attempts,
          scheduled_at: attempts >= 3 ? scheduled.scheduled_at : retryAt,
          last_error:
            sendError instanceof Error ? sendError.message.slice(0, 500) : 'Falha no envio',
          updated_at: new Date().toISOString(),
        })
        .eq('id', scheduled.id);
      failed++;
    }
  }

  return NextResponse.json({ processed: (due ?? []).length, sent, failed });
}

