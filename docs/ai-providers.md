# AI providers

The reply assistant supports OpenAI, Anthropic, and Google Gemini. An account
administrator selects a provider in **Settings → AI Assistant**, enters its API
key, tests the connection, and saves. Keys are encrypted at rest; the model ID
can be changed in the same form.

For Gemini, create an API key in
[Google AI Studio](https://aistudio.google.com/apikey). The default model is
`gemini-2.5-flash`. Gemini powers generated replies, drafts, and auto-replies.
The knowledge-base semantic search still uses OpenAI embeddings, so it needs a
separate OpenAI key; without one, the knowledge base uses keyword search.

Apply `supabase/migrations/043_ai_gemini_provider.sql` before deploying this
version. It allows Gemini to be stored as the configured provider and in the
AI usage log.
