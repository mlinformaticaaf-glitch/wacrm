import { describe, expect, it } from 'vitest';
import { validateAppointmentInput } from './validation';

const valid = {
  title: 'Atendimento inicial',
  contactId: 'contact-1',
  startsAt: '2026-10-20T14:00:00.000Z',
  endsAt: '2026-10-20T15:00:00.000Z',
};

describe('validateAppointmentInput', () => {
  it('accepts an appointment without a reminder', () => {
    const result = validateAppointmentInput(valid);
    expect(result.ok).toBe(true);
  });

  it('rejects an end before the start', () => {
    const result = validateAppointmentInput({
      ...valid,
      endsAt: '2026-10-20T13:00:00.000Z',
    });
    expect(result).toEqual({
      ok: false,
      error: 'O término deve ser posterior ao início.',
    });
  });

  it('requires an approved template name for template reminders', () => {
    const result = validateAppointmentInput({
      ...valid,
      reminder: {
        enabled: true,
        messageType: 'template',
        scheduledAt: '2026-10-20T12:00:00.000Z',
      },
    });
    expect(result).toEqual({
      ok: false,
      error: 'Selecione um modelo aprovado.',
    });
  });

  it('rejects reminders scheduled after the appointment starts', () => {
    const result = validateAppointmentInput({
      ...valid,
      reminder: {
        enabled: true,
        messageType: 'text',
        scheduledAt: '2026-10-20T14:30:00.000Z',
        contentText: 'Lembrete',
      },
    });
    expect(result).toEqual({
      ok: false,
      error: 'A mensagem deve ser enviada antes do atendimento.',
    });
  });
});

