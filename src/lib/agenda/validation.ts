export const APPOINTMENT_STATUSES = [
  'scheduled',
  'completed',
  'cancelled',
  'no_show',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export type ScheduledMessageType = 'text' | 'template';

export interface AppointmentInput {
  title: string;
  contactId: string;
  startsAt: string;
  endsAt: string;
  notes?: string | null;
  location?: string | null;
  status?: AppointmentStatus;
  reminder?: {
    enabled: boolean;
    messageType: ScheduledMessageType;
    scheduledAt: string;
    contentText?: string | null;
    templateName?: string | null;
    templateLanguage?: string | null;
  };
}

export function validateAppointmentInput(value: unknown):
  | { ok: true; data: AppointmentInput }
  | { ok: false; error: string } {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'Dados do atendimento inválidos.' };
  }

  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const contactId = typeof raw.contactId === 'string' ? raw.contactId : '';
  const startsAt = typeof raw.startsAt === 'string' ? raw.startsAt : '';
  const endsAt = typeof raw.endsAt === 'string' ? raw.endsAt : '';
  const start = new Date(startsAt);
  const end = new Date(endsAt);

  if (!title || title.length > 160) {
    return { ok: false, error: 'Informe um título de até 160 caracteres.' };
  }
  if (!contactId) return { ok: false, error: 'Selecione um contato.' };
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, error: 'Informe uma data e um horário válidos.' };
  }
  if (end <= start) {
    return { ok: false, error: 'O término deve ser posterior ao início.' };
  }

  const status = raw.status;
  if (
    status !== undefined &&
    !APPOINTMENT_STATUSES.includes(status as AppointmentStatus)
  ) {
    return { ok: false, error: 'Status do atendimento inválido.' };
  }

  let reminder: AppointmentInput['reminder'];
  if (raw.reminder && typeof raw.reminder === 'object') {
    const r = raw.reminder as Record<string, unknown>;
    const enabled = r.enabled === true;
    const messageType = r.messageType === 'template' ? 'template' : 'text';
    const scheduledAt = typeof r.scheduledAt === 'string' ? r.scheduledAt : '';
    const scheduled = new Date(scheduledAt);
    const contentText = typeof r.contentText === 'string' ? r.contentText.trim() : '';
    const templateName = typeof r.templateName === 'string' ? r.templateName.trim() : '';
    const templateLanguage =
      typeof r.templateLanguage === 'string' && r.templateLanguage
        ? r.templateLanguage
        : 'pt_BR';

    if (enabled) {
      if (Number.isNaN(scheduled.getTime())) {
        return { ok: false, error: 'Informe quando a mensagem deve ser enviada.' };
      }
      if (scheduled >= start) {
        return { ok: false, error: 'A mensagem deve ser enviada antes do atendimento.' };
      }
      if (messageType === 'text' && !contentText) {
        return { ok: false, error: 'Escreva a mensagem automática.' };
      }
      if (messageType === 'template' && !templateName) {
        return { ok: false, error: 'Selecione um modelo aprovado.' };
      }
    }

    reminder = {
      enabled,
      messageType,
      scheduledAt,
      contentText: contentText || null,
      templateName: templateName || null,
      templateLanguage,
    };
  }

  return {
    ok: true,
    data: {
      title,
      contactId,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      notes: typeof raw.notes === 'string' ? raw.notes.trim() || null : null,
      location:
        typeof raw.location === 'string' ? raw.location.trim() || null : null,
      status: (status as AppointmentStatus | undefined) ?? 'scheduled',
      reminder,
    },
  };
}

