'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { parseCoexistenceSession } from '@/lib/whatsapp/coexistence'

type Settings = { ready: boolean; appId: string; configId: string; version: string; state: string; message?: string }
type FacebookSdk = {
  init: (options: Record<string, unknown>) => void
  login: (callback: (response: { authResponse?: { code?: string } }) => void, options: Record<string, unknown>) => void
}
declare global { interface Window { FB?: FacebookSdk } }

export function WhatsAppCoexistence({ connected, onConnected }: { connected: boolean; onConnected: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [sdkReady, setSdkReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const attempt = useRef<{ code?: string; session?: { wabaId: string; phoneNumberId?: string }; submitting: boolean } | null>(null)
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
      if (!data.ready) return
      const initialize = () => {
        if (!alive || !window.FB) return
        window.FB.init({ appId: data.appId, version: data.version, cookie: true, xfbml: false })
        setSdkReady(true)
      }
      if (window.FB) { initialize(); return }
      const script = document.createElement('script')
      script.src = 'https://connect.facebook.net/pt_BR/sdk.js'
      script.async = true
      script.onload = initialize
      script.onerror = () => alive && toast.error('Não foi possível carregar a conexão da Meta.')
      document.body.appendChild(script)
    }).catch(() => alive && setSettings(null))
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!settings) return
    async function finish() {
      const current = attempt.current
      if (!current?.code || !current.session || current.submitting) return
      current.submitting = true
      try {
        const response = await fetch('/api/whatsapp/coexistence', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: current.code, ...current.session, state: settings!.state }),
        })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Falha ao conectar o número')
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
      extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
    })
  }

  return <Card>
    <CardHeader><CardTitle>WhatsApp no celular e no WACRM</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <p className="text-sm text-muted-foreground">Conecte o número que você já usa no aplicativo WhatsApp Business. A Meta pedirá a confirmação no celular. As respostas enviadas pelo aplicativo aparecerão no atendimento e pausarão a automação.</p>
      {connected && <p className="text-sm text-green-600">Conexão salva em modo coexistência.</p>}
      {!settings?.ready && <p role="status" className="text-sm text-muted-foreground">{settings?.message || 'Aguardando configuração de conexão da Meta pelo administrador.'}</p>}
      <p className="text-sm text-muted-foreground">Concluir o cadastro substitui o número conectado nesta conta do WACRM. O histórico antigo não é importado por este fluxo.</p>
      <Button type="button" onClick={connect} disabled={!sdkReady || busy}>{busy ? 'Conclua a confirmação na Meta…' : 'Conectar meu WhatsApp Business'}</Button>
    </CardContent>
  </Card>
}
