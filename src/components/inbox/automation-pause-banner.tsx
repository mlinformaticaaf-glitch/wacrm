'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

export function AutomationPauseBanner({ conversationId }: { conversationId: string }) {
  const t = useTranslations('Inbox.automationPause')
  const [busy, setBusy] = useState(false)
  const [resumed, setResumed] = useState(false)
  useEffect(() => setResumed(false), [conversationId])
  if (resumed) return null
  async function resume() {
    setBusy(true)
    try {
      const response = await fetch(`/api/ai/autoreply/${conversationId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: false }),
      })
      if (!response.ok) throw new Error('Resume failed')
      setResumed(true); toast.success(t('resumed'))
    } catch { toast.error(t('error')) }
    finally { setBusy(false) }
  }
  return <div className="flex items-center gap-3 border-t bg-muted/40 px-4 py-3">
    <div className="flex-1 text-sm"><p className="font-medium">{t('title')}</p><p className="text-muted-foreground">{t('description')}</p></div>
    <Button size="sm" variant="outline" disabled={busy} onClick={resume}>{t('resume')}</Button>
  </div>
}
