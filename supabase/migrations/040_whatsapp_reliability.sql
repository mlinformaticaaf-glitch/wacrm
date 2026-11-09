-- Durable webhook inbox, inbound idempotency, BSUID identity and
-- coexistence lifecycle/synchronization state.

-- ------------------------------------------------------------------
-- Identity fields used by WhatsApp usernames / business-scoped user IDs.
-- The phone remains the primary display/send identity when present.
-- ------------------------------------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS bsuid TEXT,
  ADD COLUMN IF NOT EXISTS app_contact_status TEXT
    CHECK (app_contact_status IN ('present', 'removed')),
  ADD COLUMN IF NOT EXISTS app_contact_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_bsuid
  ON public.contacts (account_id, bsuid)
  WHERE bsuid IS NOT NULL AND bsuid <> '';

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS from_user_id TEXT,
  ADD COLUMN IF NOT EXISTS to_user_id TEXT;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_source_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_source_check
  CHECK (source IN ('crm', 'whatsapp_business_app', 'whatsapp_history'));

-- One Meta message can occur at most once in a conversation. This covers
-- inbound deliveries, history imports, retries and app echoes.
CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_meta_unique
  ON public.messages (conversation_id, message_id)
  WHERE message_id IS NOT NULL;

-- ------------------------------------------------------------------
-- Connection and coexistence synchronization state.
-- ------------------------------------------------------------------
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS sync_contacts_request_id TEXT,
  ADD COLUMN IF NOT EXISTS sync_history_request_id TEXT,
  ADD COLUMN IF NOT EXISTS sync_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_contacts_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_history_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_history_progress INTEGER
    CHECK (sync_history_progress BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS sync_last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_connection_event TEXT,
  ADD COLUMN IF NOT EXISTS last_connection_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;

ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_status_check;
ALTER TABLE public.whatsapp_config
  ADD CONSTRAINT whatsapp_config_status_check
  CHECK (status IN (
    'onboarding', 'awaiting_authorization', 'connected',
    'coexistence', 'syncing', 'degraded', 'error', 'disconnected'
  ));

-- ------------------------------------------------------------------
-- Durable webhook inbox. The route stores a payload only after HMAC
-- verification and acknowledges Meta after this insert succeeds.
-- Access is intentionally service-role only (RLS enabled, no policies).
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payload_hash TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_ready
  ON public.whatsapp_webhook_events (available_at, created_at)
  WHERE status IN ('pending', 'failed', 'processing');

ALTER TABLE public.whatsapp_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.whatsapp_webhook_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.whatsapp_webhook_events TO service_role;

CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_account_created
  ON public.admin_audit_log (account_id, created_at DESC);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.admin_audit_log TO authenticated;
GRANT ALL ON TABLE public.admin_audit_log TO service_role;

DROP POLICY IF EXISTS admin_audit_select ON public.admin_audit_log;
CREATE POLICY admin_audit_select
  ON public.admin_audit_log FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- Atomically claim an event so an immediate after() run and a cron retry
-- cannot process the same delivery concurrently.
CREATE OR REPLACE FUNCTION public.claim_whatsapp_webhook_event(p_event_id UUID)
RETURNS TABLE (payload JSONB, attempts INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.whatsapp_webhook_events e
  SET status = 'processing',
      attempts = e.attempts + 1,
      processing_started_at = NOW(),
      updated_at = NOW()
  WHERE e.id = p_event_id
    AND (
      e.status IN ('pending', 'failed')
      OR (
        e.status = 'processing'
        AND e.processing_started_at < NOW() - INTERVAL '10 minutes'
      )
    )
    AND e.available_at <= NOW()
  RETURNING e.payload, e.attempts;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_webhook_event(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_webhook_event(UUID) TO service_role;

-- Insert a message and update its conversation in one transaction. The
-- conversation row lock serializes concurrent webhook deliveries.
CREATE OR REPLACE FUNCTION public.record_whatsapp_message(
  p_account_id UUID,
  p_conversation_id UUID,
  p_contact_id UUID,
  p_sender_type TEXT,
  p_content_type TEXT,
  p_content_text TEXT,
  p_media_url TEXT,
  p_template_name TEXT,
  p_message_id TEXT,
  p_status TEXT,
  p_created_at TIMESTAMPTZ,
  p_reply_to_message_id UUID,
  p_interactive_reply_id TEXT,
  p_from_user_id TEXT,
  p_to_user_id TEXT,
  p_increment_unread BOOLEAN,
  p_source TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_message_id UUID;
BEGIN
  PERFORM 1
  FROM public.conversations
  WHERE id = p_conversation_id
    AND account_id = p_account_id
    AND contact_id = p_contact_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation does not belong to account and contact';
  END IF;

  IF p_message_id IS NOT NULL THEN
    SELECT id INTO v_message_id
    FROM public.messages
    WHERE conversation_id = p_conversation_id
      AND message_id = p_message_id
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object('inserted', FALSE, 'message_id', v_message_id);
    END IF;
  END IF;

  INSERT INTO public.messages (
    conversation_id, sender_type, content_type, content_text, media_url,
    template_name, message_id, status, created_at, reply_to_message_id,
    interactive_reply_id, from_user_id, to_user_id, source
  ) VALUES (
    p_conversation_id, p_sender_type, p_content_type, p_content_text,
    p_media_url, p_template_name, p_message_id, p_status, p_created_at,
    p_reply_to_message_id, p_interactive_reply_id, p_from_user_id,
    p_to_user_id, p_source
  )
  ON CONFLICT (conversation_id, message_id)
    WHERE message_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_message_id;

  IF v_message_id IS NULL THEN
    RETURN jsonb_build_object('inserted', FALSE, 'message_id', NULL);
  END IF;

  UPDATE public.conversations
  SET unread_count = COALESCE(unread_count, 0)
        + CASE WHEN p_increment_unread THEN 1 ELSE 0 END,
      last_message_text = CASE
        WHEN last_message_at IS NULL OR last_message_at <= p_created_at
          THEN COALESCE(p_content_text, '[' || p_content_type || ']')
        ELSE last_message_text
      END,
      last_message_at = GREATEST(COALESCE(last_message_at, p_created_at), p_created_at),
      status = CASE
        WHEN p_increment_unread AND status = 'closed' THEN 'pending'
        ELSE status
      END,
      updated_at = NOW()
  WHERE id = p_conversation_id;

  RETURN jsonb_build_object('inserted', TRUE, 'message_id', v_message_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_whatsapp_message(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_message(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, UUID, TEXT, TEXT, TEXT, BOOLEAN, TEXT
) TO service_role;

-- Echo persistence with BSUID fields. The original 8-argument function is
-- retained for compatibility with already-deployed callers.
CREATE OR REPLACE FUNCTION public.record_whatsapp_app_message_v2(
  p_account_id UUID,
  p_conversation_id UUID,
  p_contact_id UUID,
  p_message_id TEXT,
  p_created_at TIMESTAMPTZ,
  p_content_type TEXT,
  p_content_text TEXT,
  p_media_url TEXT,
  p_reply_to_message_id UUID,
  p_from_user_id TEXT,
  p_to_user_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE inserted_id UUID;
BEGIN
  PERFORM 1
  FROM public.conversations
  WHERE id = p_conversation_id
    AND account_id = p_account_id
    AND contact_id = p_contact_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation does not belong to account and contact';
  END IF;

  INSERT INTO public.messages (
    conversation_id, sender_type, content_type, content_text, media_url,
    message_id, status, created_at, reply_to_message_id, source,
    from_user_id, to_user_id
  ) VALUES (
    p_conversation_id, 'agent', p_content_type, p_content_text, p_media_url,
    p_message_id, 'sent', p_created_at, p_reply_to_message_id,
    'whatsapp_business_app', p_from_user_id, p_to_user_id
  )
  ON CONFLICT (conversation_id, message_id)
    WHERE message_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE public.conversations
  SET automation_paused_at = NOW(),
      ai_autoreply_disabled = TRUE,
      updated_at = NOW(),
      last_message_text = CASE
        WHEN last_message_at IS NULL OR last_message_at <= p_created_at
          THEN COALESCE(p_content_text, '[' || p_content_type || ']')
        ELSE last_message_text
      END,
      last_message_at = GREATEST(COALESCE(last_message_at, p_created_at), p_created_at)
  WHERE id = p_conversation_id;

  UPDATE public.flow_runs
  SET status = 'paused_by_agent',
      ended_at = NOW(),
      end_reason = 'whatsapp_business_app_replied'
  WHERE account_id = p_account_id
    AND contact_id = p_contact_id
    AND status = 'active';

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.record_whatsapp_app_message_v2(
  UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_app_message_v2(
  UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, UUID, TEXT, TEXT
) TO service_role;
