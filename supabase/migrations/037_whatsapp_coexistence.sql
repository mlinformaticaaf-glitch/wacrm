-- Coexistence keeps app-sent messages separate from customer messages.
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_mode text NOT NULL DEFAULT 'cloud_api'
  CHECK (connection_mode IN ('cloud_api', 'coexistence'));
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS automation_paused_at timestamptz;
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'crm'
  CHECK (source IN ('crm', 'whatsapp_business_app'));
-- Meta retries must not create duplicate app messages. CRM sends use a
-- different source and are deliberately outside this partial index.
CREATE UNIQUE INDEX IF NOT EXISTS messages_app_echo_unique
  ON public.messages (conversation_id, message_id)
  WHERE source = 'whatsapp_business_app' AND message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_whatsapp_app_message(
  p_account_id uuid, p_conversation_id uuid, p_contact_id uuid,
  p_message_id text, p_created_at timestamptz, p_content_type text,
  p_content_text text, p_media_url text, p_reply_to_message_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE inserted_id uuid;
BEGIN
  -- Serialize app events with conversation updates. Ownership is checked
  -- even though only the server's service role can execute this function.
  PERFORM id FROM conversations WHERE id = p_conversation_id
    AND account_id = p_account_id AND contact_id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation does not belong to account'; END IF;
  INSERT INTO messages (conversation_id, sender_type, content_type,
    content_text, media_url, message_id, status, created_at,
    reply_to_message_id, source)
  VALUES (p_conversation_id, 'agent', p_content_type, p_content_text,
    p_media_url, p_message_id, 'sent', p_created_at,
    p_reply_to_message_id, 'whatsapp_business_app')
  ON CONFLICT (conversation_id, message_id)
    WHERE source = 'whatsapp_business_app' AND message_id IS NOT NULL
    DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN RETURN false; END IF;
  UPDATE conversations SET automation_paused_at = now(),
    ai_autoreply_disabled = true, updated_at = now(),
    last_message_text = CASE WHEN last_message_at IS NULL OR last_message_at <= p_created_at
      THEN coalesce(p_content_text, '[' || p_content_type || ']') ELSE last_message_text END,
    last_message_at = greatest(last_message_at, p_created_at)
    WHERE id = p_conversation_id;
  UPDATE flow_runs SET status = 'paused_by_agent', ended_at = now(),
    end_reason = 'whatsapp_business_app_replied'
    WHERE account_id = p_account_id AND contact_id = p_contact_id AND status = 'active';
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.record_whatsapp_app_message(uuid, uuid, uuid, text, timestamptz, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_app_message(uuid, uuid, uuid, text, timestamptz, text, text, text, uuid) TO service_role;
