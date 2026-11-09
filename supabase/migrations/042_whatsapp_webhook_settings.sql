CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_settings (
  account_id UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  verify_token TEXT NOT NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.whatsapp_webhook_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.whatsapp_webhook_settings FROM anon, authenticated;
GRANT ALL ON public.whatsapp_webhook_settings TO service_role;
