-- Atomic per-stream claims prevent concurrent requests from starting the
-- same one-shot Meta contacts/history synchronization more than once.
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS sync_contacts_claim_id UUID,
  ADD COLUMN IF NOT EXISTS sync_contacts_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_history_claim_id UUID,
  ADD COLUMN IF NOT EXISTS sync_history_claimed_at TIMESTAMPTZ;

ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_sync_claim_pairs_check;

ALTER TABLE public.whatsapp_config
  ADD CONSTRAINT whatsapp_config_sync_claim_pairs_check
  CHECK (
    (sync_contacts_claim_id IS NULL) = (sync_contacts_claimed_at IS NULL)
    AND (sync_history_claim_id IS NULL) = (sync_history_claimed_at IS NULL)
  );
