import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { validateAppointmentInput } from '@/lib/agenda/validation';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const { supabase, accountId, userId } = await requireRole('agent');
    const body = await request.json().catch(() => null);
    const validated = validateAppointmentInput(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    const input = validated.data;

    const { data: existing } = await supabase
      .from('appointments')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: 'Não encontrado.' }, { status: 404 });

    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', input.contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!contact) {
      return NextResponse.json({ error: 'Contato não encontrado.' }, { status: 404 });
    }

    const { error } = await supabase
      .from('appointments')
      .update({
        contact_id: input.contactId,
        title: input.title,
        notes: input.notes,
        location: input.location,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        status: input.status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await supabase
      .from('scheduled_messages')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('appointment_id', id)
      .eq('status', 'pending');

    if (input.reminder?.enabled && input.status === 'scheduled') {
      const { error: reminderError } = await supabase
        .from('scheduled_messages')
        .insert({
          account_id: accountId,
          user_id: userId,
          appointment_id: id,
          contact_id: input.contactId,
          message_type: input.reminder.messageType,
          content_text: input.reminder.contentText,
          template_name: input.reminder.templateName,
          template_language: input.reminder.templateLanguage,
          scheduled_at: input.reminder.scheduledAt,
        });
      if (reminderError) {
        return NextResponse.json({ error: reminderError.message }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole('agent');

    await supabase
      .from('scheduled_messages')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('appointment_id', id)
      .eq('status', 'pending');

    const { error } = await supabase
      .from('appointments')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

