'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Loader2,
  MapPin,
  MessageCircleMore,
  MoreHorizontal,
  Plus,
  Trash2,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type {
  Appointment,
  AppointmentStatus,
  Contact,
  MessageTemplate,
  ScheduledMessage,
} from '@/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type ContactOption = Pick<Contact, 'id' | 'name' | 'phone' | 'avatar_url'>;
type TemplateOption = Pick<MessageTemplate, 'id' | 'name' | 'language' | 'body_text' | 'status'>;
type HydratedAppointment = Appointment & {
  contact?: ContactOption;
  scheduled_messages?: ScheduledMessage[];
};

type FormState = {
  title: string;
  contactId: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  notes: string;
  status: AppointmentStatus;
  reminderEnabled: boolean;
  messageType: 'text' | 'template';
  reminderDate: string;
  reminderTime: string;
  contentText: string;
  templateId: string;
};

const STATUS_STYLES: Record<AppointmentStatus, string> = {
  scheduled: 'bg-primary/10 text-primary',
  completed: 'bg-emerald-500/10 text-emerald-500',
  cancelled: 'bg-muted text-muted-foreground',
  no_show: 'bg-amber-500/10 text-amber-400',
};

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDateTime(date: Date) {
  return `${dateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function combineLocal(date: string, time: string) {
  return new Date(`${date}T${time}:00`);
}

function startOfMonthGrid(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  first.setDate(first.getDate() - mondayOffset);
  first.setHours(0, 0, 0, 0);
  return first;
}

function emptyForm(day: Date): FormState {
  const start = new Date(day);
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setHours(10);
  const reminder = new Date(start);
  reminder.setDate(reminder.getDate() - 1);
  return {
    title: '',
    contactId: '',
    date: dateKey(start),
    startTime: '09:00',
    endTime: '10:00',
    location: '',
    notes: '',
    status: 'scheduled',
    reminderEnabled: false,
    messageType: 'template',
    reminderDate: dateKey(reminder),
    reminderTime: '09:00',
    contentText: '',
    templateId: '',
  };
}

export function AgendaView() {
  const t = useTranslations('Agenda');
  const locale = useLocale();
  const today = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  );
  const [selectedDay, setSelectedDay] = useState(() => dateKey(today));
  const [appointments, setAppointments] = useState<HydratedAppointment[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<HydratedAppointment | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(() => emptyForm(today));

  const gridStart = useMemo(() => startOfMonthGrid(month), [month]);
  const gridDays = useMemo(
    () => Array.from({ length: 42 }, (_, index) => {
      const day = new Date(gridStart);
      day.setDate(day.getDate() + index);
      return day;
    }),
    [gridStart],
  );

  const loadAgenda = useCallback(async () => {
    setLoading(true);
    const from = new Date(gridStart);
    const to = new Date(gridStart);
    to.setDate(to.getDate() + 42);
    try {
      const response = await fetch(
        `/api/agenda?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t('loadFailed'));
      setAppointments(body.appointments ?? []);
      setContacts(body.contacts ?? []);
      setTemplates(body.templates ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [gridStart, t]);

  useEffect(() => {
    void loadAgenda();
  }, [loadAgenda]);

  const appointmentsByDay = useMemo(() => {
    const map = new Map<string, HydratedAppointment[]>();
    for (const appointment of appointments) {
      const key = dateKey(new Date(appointment.starts_at));
      map.set(key, [...(map.get(key) ?? []), appointment]);
    }
    return map;
  }, [appointments]);

  const selectedAppointments = appointmentsByDay.get(selectedDay) ?? [];
  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
  }).format(month);
  const selectedLabel = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${selectedDay}T12:00:00`));
  const weekdays = useMemo(() => {
    const monday = new Date(2024, 0, 1);
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(monday);
      day.setDate(day.getDate() + index);
      return new Intl.DateTimeFormat(locale, { weekday: 'short' })
        .format(day)
        .replace('.', '')
        .slice(0, 3);
    });
  }, [locale]);

  function changeMonth(offset: number) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  function openNew(dayKey = selectedDay) {
    const day = new Date(`${dayKey}T12:00:00`);
    setEditing(null);
    setForm(emptyForm(day));
    setSheetOpen(true);
  }

  function openEdit(appointment: HydratedAppointment) {
    const start = new Date(appointment.starts_at);
    const end = new Date(appointment.ends_at);
    const reminder = appointment.scheduled_messages?.find((item) => item.status === 'pending');
    const reminderAt = reminder ? new Date(reminder.scheduled_at) : new Date(start.getTime() - 86_400_000);
    const template = templates.find(
      (item) => item.name === reminder?.template_name && item.language === reminder?.template_language,
    );
    setEditing(appointment);
    setForm({
      title: appointment.title,
      contactId: appointment.contact_id,
      date: dateKey(start),
      startTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
      endTime: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
      location: appointment.location ?? '',
      notes: appointment.notes ?? '',
      status: appointment.status,
      reminderEnabled: !!reminder,
      messageType: reminder?.message_type ?? 'template',
      reminderDate: dateKey(reminderAt),
      reminderTime: `${pad(reminderAt.getHours())}:${pad(reminderAt.getMinutes())}`,
      contentText: reminder?.content_text ?? '',
      templateId: template?.id ?? '',
    });
    setSheetOpen(true);
  }

  async function saveAppointment() {
    const start = combineLocal(form.date, form.startTime);
    const end = combineLocal(form.date, form.endTime);
    const selectedTemplate = templates.find((item) => item.id === form.templateId);
    const payload = {
      title: form.title,
      contactId: form.contactId,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      location: form.location,
      notes: form.notes,
      status: form.status,
      reminder: {
        enabled: form.reminderEnabled,
        messageType: form.messageType,
        scheduledAt: combineLocal(form.reminderDate, form.reminderTime).toISOString(),
        contentText: form.contentText,
        templateName: selectedTemplate?.name ?? null,
        templateLanguage: selectedTemplate?.language ?? 'pt_BR',
      },
    };

    setSaving(true);
    try {
      const response = await fetch(editing ? `/api/agenda/${editing.id}` : '/api/agenda', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t('saveFailed'));
      toast.success(editing ? t('updated') : t('created'));
      setSheetOpen(false);
      setSelectedDay(form.date);
      await loadAgenda();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function deleteAppointment(appointment: HydratedAppointment) {
    if (!window.confirm(t('deleteConfirm', { title: appointment.title }))) return;
    try {
      const response = await fetch(`/api/agenda/${appointment.id}`, { method: 'DELETE' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t('deleteFailed'));
      toast.success(t('deleted'));
      await loadAgenda();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('deleteFailed'));
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">{t('title')}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t('description')}</p>
        </div>
        <Button className="h-11 w-full sm:w-auto" onClick={() => openNew()}>
          <Plus className="size-4" />
          {t('newAppointment')}
        </Button>
      </header>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="min-w-0 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-3 sm:px-5">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" aria-label={t('previousMonth')} onClick={() => changeMonth(-1)}>
                <ChevronLeft className="size-4" />
              </Button>
              <h2 className="min-w-36 text-center text-base font-semibold capitalize text-foreground sm:min-w-44">
                {monthLabel}
              </h2>
              <Button variant="ghost" size="icon" aria-label={t('nextMonth')} onClick={() => changeMonth(1)}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
                setSelectedDay(dateKey(today));
              }}
            >
              {t('today')}
            </Button>
          </div>

          <div className="grid grid-cols-7 border-b border-border bg-muted/40">
            {weekdays.map((weekday) => (
              <div key={weekday} className="py-2 text-center text-[11px] font-semibold uppercase text-muted-foreground sm:text-xs">
                {weekday}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7" aria-busy={loading}>
            {gridDays.map((day) => {
              const key = dateKey(day);
              const items = appointmentsByDay.get(key) ?? [];
              const isCurrentMonth = day.getMonth() === month.getMonth();
              const isSelected = key === selectedDay;
              const isToday = key === dateKey(today);
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => setSelectedDay(key)}
                  onDoubleClick={() => openNew(key)}
                  aria-pressed={isSelected}
                  aria-label={`${day.toLocaleDateString(locale)} — ${items.length} ${t('appointmentsCount')}`}
                  className={cn(
                    'relative min-h-16 border-r border-b border-border p-1.5 text-left transition-colors last:border-r-0 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:min-h-24 sm:p-2',
                    isCurrentMonth ? 'bg-card' : 'bg-muted/20 text-muted-foreground/50',
                    isSelected && 'bg-primary/10',
                    !isSelected && 'hover:bg-muted/60',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-7 items-center justify-center rounded-full text-xs tabular-nums sm:text-sm',
                      isToday && 'bg-primary font-semibold text-primary-foreground',
                    )}
                  >
                    {day.getDate()}
                  </span>
                  {items.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1 sm:block">
                      {items.slice(0, 2).map((item) => (
                        <span
                          key={item.id}
                          className="mb-1 block size-1.5 rounded-full bg-primary sm:h-auto sm:w-full sm:truncate sm:rounded-md sm:bg-primary/10 sm:px-1.5 sm:py-1 sm:text-[11px] sm:font-medium sm:text-primary"
                        >
                          <span className="hidden sm:inline">{item.title}</span>
                        </span>
                      ))}
                      {items.length > 2 ? (
                        <span className="hidden text-[10px] text-muted-foreground sm:block">+{items.length - 2}</span>
                      ) : null}
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        <aside className="min-w-0 rounded-xl bg-card ring-1 ring-foreground/10 xl:max-h-[calc(100dvh-10rem)] xl:overflow-y-auto">
          <div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-4">
            <h2 className="text-base font-semibold capitalize text-foreground">{selectedLabel}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('daySummary', { count: selectedAppointments.length })}
            </p>
          </div>

          {loading ? (
            <div className="flex min-h-48 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : selectedAppointments.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
              <CalendarDays className="size-9 text-muted-foreground/60" />
              <p className="mt-4 font-medium text-foreground">{t('emptyDay')}</p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">{t('emptyDayHint')}</p>
              <Button variant="outline" className="mt-5 h-11" onClick={() => openNew()}>
                <Plus className="size-4" /> {t('schedule')}
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {selectedAppointments.map((appointment) => (
                <AppointmentRow
                  key={appointment.id}
                  appointment={appointment}
                  locale={locale}
                  statusLabel={t(`status.${appointment.status}`)}
                  reminderLabel={t('automaticMessage')}
                  onOpen={() => openEdit(appointment)}
                  onDelete={() => void deleteAppointment(appointment)}
                  editLabel={t('edit')}
                  deleteLabel={t('delete')}
                />
              ))}
            </div>
          )}
        </aside>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full max-w-xl gap-0 overflow-hidden sm:max-w-xl">
          <SheetHeader className="border-b border-border px-5 py-4 pr-14">
            <SheetTitle>{editing ? t('editAppointment') : t('newAppointment')}</SheetTitle>
            <SheetDescription>{t('formDescription')}</SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            <Field label={t('appointmentTitle')} required>
              <Input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                placeholder={t('titlePlaceholder')}
                className="h-11"
              />
            </Field>

            <Field label={t('contact')} required>
              <Select value={form.contactId} onValueChange={(value) => setForm({ ...form, contactId: value ?? '' })}>
                <SelectTrigger className="h-11 w-full">
                  <SelectValue placeholder={t('selectContact')} />
                </SelectTrigger>
                <SelectContent>
                  {contacts.map((contact) => (
                    <SelectItem key={contact.id} value={contact.id}>
                      {contact.name || contact.phone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <div className="grid gap-4 sm:grid-cols-[1fr_8rem_8rem]">
              <Field label={t('date')} required>
                <Input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} className="h-11" />
              </Field>
              <Field label={t('start')} required>
                <Input type="time" value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} className="h-11" />
              </Field>
              <Field label={t('end')} required>
                <Input type="time" value={form.endTime} onChange={(event) => setForm({ ...form, endTime: event.target.value })} className="h-11" />
              </Field>
            </div>

            <Field label={t('location')}>
              <Input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} placeholder={t('locationPlaceholder')} className="h-11" />
            </Field>

            <Field label={t('notes')}>
              <Textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder={t('notesPlaceholder')} className="min-h-24 resize-none" />
            </Field>

            {editing ? (
              <Field label={t('statusLabel')}>
                <Select value={form.status} onValueChange={(value) => setForm({ ...form, status: value as AppointmentStatus })}>
                  <SelectTrigger className="h-11 w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(['scheduled', 'completed', 'cancelled', 'no_show'] as const).map((status) => (
                      <SelectItem key={status} value={status}>{t(`status.${status}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}

            <section className="rounded-xl bg-muted/40 p-4 ring-1 ring-foreground/10">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Label htmlFor="reminder-enabled" className="text-sm font-semibold text-foreground">{t('automaticMessage')}</Label>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('automaticMessageHint')}</p>
                </div>
                <Switch id="reminder-enabled" checked={form.reminderEnabled} onCheckedChange={(checked) => setForm({ ...form, reminderEnabled: checked })} />
              </div>

              {form.reminderEnabled ? (
                <div className="mt-5 space-y-4 border-t border-border pt-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t('sendDate')} required>
                      <Input type="date" value={form.reminderDate} onChange={(event) => setForm({ ...form, reminderDate: event.target.value })} className="h-11 bg-background" />
                    </Field>
                    <Field label={t('sendTime')} required>
                      <Input type="time" value={form.reminderTime} onChange={(event) => setForm({ ...form, reminderTime: event.target.value })} className="h-11 bg-background" />
                    </Field>
                  </div>

                  <Field label={t('messageType')}>
                    <Select value={form.messageType} onValueChange={(value) => setForm({ ...form, messageType: value as 'text' | 'template' })}>
                      <SelectTrigger className="h-11 w-full bg-background"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="template">{t('approvedTemplate')}</SelectItem>
                        <SelectItem value="text">{t('freeText')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>

                  {form.messageType === 'template' ? (
                    <Field label={t('template')} required>
                      <Select value={form.templateId} onValueChange={(value) => setForm({ ...form, templateId: value ?? '' })}>
                        <SelectTrigger className="h-11 w-full bg-background"><SelectValue placeholder={t('selectTemplate')} /></SelectTrigger>
                        <SelectContent>
                          {templates.map((template) => (
                            <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {templates.length === 0 ? <p className="mt-2 text-xs text-amber-400">{t('noTemplates')}</p> : null}
                    </Field>
                  ) : (
                    <Field label={t('message')} required>
                      <Textarea value={form.contentText} onChange={(event) => setForm({ ...form, contentText: event.target.value })} placeholder={t('messagePlaceholder')} className="min-h-28 resize-none bg-background" />
                      <p className="mt-2 text-xs leading-5 text-amber-400">{t('sessionWarning')}</p>
                    </Field>
                  )}
                </div>
              ) : null}
            </section>
          </div>

          <SheetFooter className="border-t border-border bg-card px-5 py-4 sm:flex-row sm:justify-end">
            <Button variant="outline" className="h-11" onClick={() => setSheetOpen(false)} disabled={saving}>{t('cancel')}</Button>
            <Button className="h-11" onClick={() => void saveAppointment()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              {saving ? t('saving') : t('save')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-2">
      <Label className="text-sm text-foreground">
        {label}{required ? <span className="ml-1 text-primary">*</span> : null}
      </Label>
      {children}
    </div>
  );
}

function AppointmentRow({
  appointment,
  locale,
  statusLabel,
  reminderLabel,
  onOpen,
  onDelete,
  editLabel,
  deleteLabel,
}: {
  appointment: HydratedAppointment;
  locale: string;
  statusLabel: string;
  reminderLabel: string;
  onOpen: () => void;
  onDelete: () => void;
  editLabel: string;
  deleteLabel: string;
}) {
  const start = new Date(appointment.starts_at);
  const end = new Date(appointment.ends_at);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const reminder = appointment.scheduled_messages?.find((item) => item.status === 'pending');

  return (
    <article className="group px-4 py-4 transition-colors hover:bg-muted/40">
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Clock3 className="size-4" />
        </div>
        <button type="button" className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={onOpen}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 flex-1 break-words text-sm font-semibold text-foreground">{appointment.title}</h3>
            <Badge className={STATUS_STYLES[appointment.status]}>{statusLabel}</Badge>
          </div>
          <p className="mt-1 text-sm font-medium tabular-nums text-primary">{time.format(start)}–{time.format(end)}</p>
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <p className="flex items-center gap-1.5"><UserRound className="size-3.5 shrink-0" /><span className="truncate">{appointment.contact?.name || appointment.contact?.phone}</span></p>
            {appointment.location ? <p className="flex items-center gap-1.5"><MapPin className="size-3.5 shrink-0" /><span className="break-words">{appointment.location}</span></p> : null}
            {reminder ? <p className="flex items-center gap-1.5 text-primary"><MessageCircleMore className="size-3.5 shrink-0" /><span>{reminderLabel} · {time.format(new Date(reminder.scheduled_at))}</span></p> : null}
          </div>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={editLabel} />}>
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpen}>{editLabel}</DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} className="text-destructive">
              <Trash2 className="size-4" /> {deleteLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
