'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseCoexistenceSession } from '@/lib/whatsapp/coexistence'

type Settings = {
  ready: boolean
  appId: string
  configId: string
  version: string
  state: string
  webhookTokenConfigured: boolean
  message?: string | null
  problems?: string[]
}
type ConnectResult = {
  error?: string
  warnings?: string[]
  alreadyStarted?: boolean
  inProgress?: boolean
  meta?: { fbtrace_id?: string | null }
}
type FacebookSdk = {
  init: (options: Record<string, unknown>) => void
  login: (callback: (response: { authResponse?: { code?: string } }) => void, options: Record<string, unknown>) => void
}
declare global { interface Window { FB?: FacebookSdk } }

export function WhatsAppCoexistence({ connected, isOwner, onConnected }: {
  connected: boolean
  isOwner: boolean
  onConnected: () => void
}) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sdkReady, setSdkReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [webhookToken, setWebhookToken] = useState('')
  const [savingWebhookToken, setSavingWebhookToken] = useState(false)
  const attempt = useRef<{
    code?: string
    session?: { wabaIds: string[]; wabaId?: string; phoneNumberId?: string }
    submitting: boolean
  } | null>(null)
  const completed = useRef(onConnected)
  const finishRef = useRef<() => void>(() => {})
  useEffect(() => { completed.current = onConnected }, [onConnected])

  useEffect(() => {
    let alive = true
    fetch('/api/whatsapp/coexistence', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('Configuration unavailable')
      const data: Settings = await response.json()
      if (!alive) return
      setSettings(data)
    }).catch(() => alive && setSettings(null))
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!settings?.ready) return
    let alive = true
    const initialize = () => {
      if (!alive || !window.FB) return
      window.FB.init({ appId: settings.appId, version: settings.version, cookie: true, xfbml: false })
      setSdkReady(true)
    }
    if (window.FB) {
      initialize()
      return () => { alive = false }
    }
    let script = document.querySelector<HTMLScriptElement>('script[data-wacrm-facebook-sdk]')
    if (!script) {
      script = document.createElement('script')
      script.src = 'https://connect.facebook.net/pt_BR/sdk.js'
      script.async = true
      script.dataset.wacrmFacebookSdk = 'true'
      document.body.appendChild(script)
    }
    script.addEventListener('load', initialize, { once: true })
    script.addEventListener('error', () => alive && toast.error('Não foi possível carregar a conexão da Meta.'), { once: true })
    return () => { alive = false }
  }, [settings?.ready, settings?.appId, settings?.version])

  useEffect(() => {
    if (!settings) return
    async function finish() {
      const current = attempt.current
      if (!current?.code || !current.session || current.submitting) return
      current.submitting = true
      try {
        const response = await fetch('/api/whatsapp/coexistence', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: current.code,
            ...current.session,
            ...(current.session.wabaId ? { wabaId: current.session.wabaId } : {}),
            state: settings!.state,
          }),
        })
        const result: ConnectResult = await response.json()
        if (!response.ok) {
          // The server returns Meta's fbtrace_id so support can locate the
          // rejected request in the App Dashboard.
          const trace = result.meta?.fbtrace_id ? ` (fbtrace_id ${result.meta.fbtrace_id})` : ''
          throw new Error(`${result.error || 'Falha ao conectar o número'}${trace}`)
        }
        toast.success('Número conectado ao WACRM e ao WhatsApp Business do celular.')
        completed.current()
      } catch (error) { toast.error(error instanceof Error ? error.message : 'Falha na conexão') }
      finally { attempt.current = null; setBusy(false) }
    }
    const listener = (event: MessageEvent) => {
      const session = parseCoexistenceSession(event.origin, event.data)
      if (!session || !attempt.current) return
      attempt.current.session = session
      void finish()
    }
    finishRef.current = () => { void finish() }
    // SDK callback and postMessage can arrive in either order.
    window.addEventListener('message', listener)
    return () => { finishRef.current = () => {}; window.removeEventListener('message', listener) }
  }, [settings])

  useEffect(() => {
    if (!busy) return
    const timer = window.setTimeout(() => {
      if (attempt.current?.submitting) return
      attempt.current = null; setBusy(false)
      toast.error('A conexão não foi concluída. Recarregue a página e tente novamente.')
    }, 600000)
    return () => window.clearTimeout(timer)
  }, [busy])

  function connect() {
    if (!settings?.ready || !window.FB || busy) return
    attempt.current = { submitting: false }; setBusy(true)
    // Must remain synchronous in this click handler to allow the popup.
    window.FB.login(response => {
      if (!attempt.current) return
      if (!response.authResponse?.code) {
        attempt.current = null; setBusy(false)
        toast.info('Conexão cancelada na Meta.'); return
      }
      attempt.current.code = response.authResponse.code
      finishRef.current()
    }, {
      config_id: settings.configId, response_type: 'code', override_default_response_type: true,
      // Embedded Signup v5 enables WhatsApp Business app onboarding by
      // default and returns the v5 session-info shape. v2/v3 were retired
      // by Meta on 2026-10-15, so select the current contract explicitly.
      extras: { setup: {}, version: 'v5' },
    })
  }

  async function startSync() {
    setSyncing(true)
    try {
      const response = await fetch('/api/whatsapp/coexistence/sync', { method: 'POST' })
      const result: ConnectResult = await response.json()
      if (!response.ok) throw new Error(result.error || 'Falha ao iniciar a sincronização')
      if (result.warnings?.length) {
        toast.warning(`Sincronização parcial: ${result.warnings.join(' | ')}`, { duration: 12000 })
      } else if (result.alreadyStarted) {
        toast.info('A sincronização deste número já foi iniciada pela Meta.')
      } else if (result.inProgress) {
        toast.info('A sincronização está sendo iniciada. Aguarde antes de tentar novamente.')
      } else {
        toast.success('Sincronização de contatos e histórico solicitada à Meta.')
      }
      onConnected()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao iniciar a sincronização')
    } finally {
      setSyncing(false)
    }
  }

  async function saveWebhookToken() {
    setSavingWebhookToken(true)
    try {
      const response = await fetch('/api/whatsapp/coexistence/webhook-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verifyToken: webhookToken }),
      })
      const result: ConnectResult = await response.json()
      if (!response.ok) throw new Error(result.error || 'Não foi possível salvar o token.')
      setWebhookToken('')
      const settingsResponse = await fetch('/api/whatsapp/coexistence', { cache: 'no-store' })
      if (!settingsResponse.ok) throw new Error('Token salvo, mas não foi possível atualizar o status.')
      setSettings(await settingsResponse.json())
      toast.success('Token de verificação salvo com segurança.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar o token.')
    } finally {
      setSavingWebhookToken(false)
    }
  }

  return <Card>
    <CardHeader><CardTitle>WhatsApp no celular e no WACRM</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p className="text-sm text-muted-foreground">Conecte o número que você já usa no aplicativo WhatsApp Business. A Meta pedirá a confirmação no celular. As respostas enviadas pelo aplicativo aparecerão no atendimento e pausarão a automação.</p>
      {connected && <p className="text-sm text-green-600">Conexão salva em modo coexistência.</p>}
      {!settings?.ready && <div role="status" className="space-y-1 text-sm text-muted-foreground">
        <p>{settings?.message || 'Aguardando configuração de conexão da Meta pelo administrador.'}</p>
        {!!settings?.problems?.length && <ul className="list-disc space-y-0.5 pl-5">
          {settings.problems.map(problem => <li key={problem}>{problem}</li>)}
        </ul>}
      </div>}
      {settings && !settings.webhookTokenConfigured && (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="space-y-1">
            <Label htmlFor="coexistence-webhook-token">Token de verificação do webhook</Label>
            <p className="text-sm text-muted-foreground">
              Salve esse token antes de conectar o número. Guarde o valor e use-o também no campo “Verify token” da Meta; por segurança, ele não será exibido novamente após salvar.
            </p>
          </div>
          {isOwner ? (
            <div className="flex flex-wrap gap-2">
              <Input
                id="coexistence-webhook-token"
                type="text"
                autoComplete="off"
                maxLength={512}
                value={webhookToken}
                onChange={event => setWebhookToken(event.target.value)}
                placeholder="Crie um token de pelo menos 16 caracteres"
                aria-label="Token de verificação do webhook"
              />
              <Button
                type="button"
                onClick={saveWebhookToken}
                disabled={savingWebhookToken || webhookToken.trim().length < 16}
              >
                {savingWebhookToken ? 'Salvando…' : 'Salvar token'}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Peça ao proprietário da conta para salvar o token de verificação.
            </p>
          )}
        </div>
      )}
      <p className="text-sm text-muted-foreground">Concluir o cadastro substitui o número conectado nesta conta do WACRM. A importação de contatos e histórico depende do consentimento no celular e pode levar alguns minutos.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={connect} disabled={!settings?.ready || !sdkReady || busy}>{busy ? 'Conclua a confirmação na Meta…' : 'Conectar meu WhatsApp Business'}</Button>
        {connected && (
          <Button type="button" variant="outline" onClick={startSync} disabled={syncing}>
            {syncing ? 'Solicitando sincronização…' : 'Sincronizar contatos e histórico'}
          </Button>
        )}
      </div>
    </CardContent>
  </Card>
}
