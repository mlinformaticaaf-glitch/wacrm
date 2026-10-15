import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { validateAppointmentInput } from '@/lib/agenda/validation';

function parseRange(request: Request) {
  const url = new URL(request.url);
  const from = new Date(url.searchParams.get('from') ?? '');
  const to = new Date(url.searchParams.get('to') ?? '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return null;
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const range = parseRange(request);
    if (!range) {
      return NextResponse.json({ error: 'Período inválido.' }, { status: 400 });
    }

    const [{ data: appointments, error }, { data: contacts }, { data: templates }] =
      await Promise.all([
        supabase
          .from('appointments')
          .select(
            '*, contact:contacts(id, name, phone, avatar_url), scheduled_messages(*)',
          )
          .eq('account_id', accountId)
          .gte('starts_at', range.from)
          .lt('starts_at', range.to)
          .order('starts_at', { ascending: true }),
        supabase
          .from('contacts')
          .select('id, name, phone, avatar_url')
          .eq('account_id', accountId)
          .order('name', { ascending: true })
          .limit(500),
        supabase
          .from('message_templates')
          .select('id, name, language, body_text, status')
          .eq('account_id', accountId)
          .eq('status', 'APPROVED')
          .order('name', { ascending: true }),
      ]);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({
      appointments: appointments ?? [],
      contacts: contacts ?? [],
      templates: templates ?? [],
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const body = await request.json().catch(() => null);
    const validated = validateAppointmentInput(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    const input = validated.data;

    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('id', input.contactId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!contact) {
      return NextResponse.json({ error: 'Contato não encontrado.' }, { status: 404 });
    }

    const { data: appointment, error } = await supabase
      .from('appointments')
      .insert({
        account_id: accountId,
        user_id: userId,
        contact_id: input.contactId,
        title: input.title,
        notes: input.notes,
        location: input.location,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        status: input.status,
      })
      .select()
      .single();

    if (error || !appointment) {
      return NextResponse.json(
        { error: error?.message ?? 'Não foi possível criar o atendimento.' },
        { status: 500 },
      );
    }

    if (input.reminder?.enabled) {
      const { error: reminderError } = await supabase
        .from('scheduled_messages')
        .insert({
          account_id: accountId,
          user_id: userId,
          appointment_id: appointment.id,
          contact_id: input.contactId,
          message_type: input.reminder.messageType,
          content_text: input.reminder.contentText,
          template_name: input.reminder.templateName,
          template_language: input.reminder.templateLanguage,
          scheduled_at: input.reminder.scheduledAt,
        });
      if (reminderError) {
        await supabase.from('appointments').delete().eq('id', appointment.id);
        return NextResponse.json({ error: reminderError.message }, { status: 500 });
      }
    }

    return NextResponse.json({ appointment }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

