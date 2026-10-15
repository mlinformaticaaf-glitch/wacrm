-- ============================================================
-- Agenda: appointments + scheduled WhatsApp messages
-- ============================================================

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  notes TEXT,
  location TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_appointments_account_start
  ON appointments(account_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_contact
  ON appointments(account_id, contact_id);

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appointments_select ON appointments;
DROP POLICY IF EXISTS appointments_insert ON appointments;
DROP POLICY IF EXISTS appointments_update ON appointments;
DROP POLICY IF EXISTS appointments_delete ON appointments;
CREATE POLICY appointments_select ON appointments FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY appointments_insert ON appointments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY appointments_update ON appointments FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY appointments_delete ON appointments FOR DELETE
  USING (is_account_member(account_id, 'agent'));

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'template')),
  content_text TEXT,
  template_name TEXT,
  template_language TEXT NOT NULL DEFAULT 'pt_BR',
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  whatsapp_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (message_type = 'text' AND content_text IS NOT NULL AND char_length(trim(content_text)) > 0)
    OR
    (message_type = 'template' AND template_name IS NOT NULL AND char_length(trim(template_name)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages(status, scheduled_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_appointment
  ON scheduled_messages(appointment_id);

ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduled_messages_select ON scheduled_messages;
DROP POLICY IF EXISTS scheduled_messages_insert ON scheduled_messages;
DROP POLICY IF EXISTS scheduled_messages_update ON scheduled_messages;
DROP POLICY IF EXISTS scheduled_messages_delete ON scheduled_messages;
CREATE POLICY scheduled_messages_select ON scheduled_messages FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY scheduled_messages_insert ON scheduled_messages FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY scheduled_messages_update ON scheduled_messages FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY scheduled_messages_delete ON scheduled_messages FOR DELETE
  USING (is_account_member(account_id, 'agent'));

