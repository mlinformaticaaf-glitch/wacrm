'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Share2, Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function PwaInstallCard() {
  const t = useTranslations('Settings.appearance');
  const [installPrompt, setInstallPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent));
      setIsStandalone(
        window.matchMedia('(display-mode: standalone)').matches ||
          ('standalone' in navigator &&
            Boolean(
              (navigator as Navigator & { standalone?: boolean }).standalone
            ))
      );
      if (window.__wacrmInstallPrompt) {
        setInstallPrompt(
          window.__wacrmInstallPrompt as BeforeInstallPromptEvent
        );
      }
    });

    const onInstalled = () => {
      window.__wacrmInstallPrompt = undefined;
      setInstallPrompt(null);
      setIsStandalone(true);
    };
    const onInstallAvailable = () => {
      if (window.__wacrmInstallPrompt) {
        setInstallPrompt(
          window.__wacrmInstallPrompt as BeforeInstallPromptEvent
        );
      }
    };

    window.addEventListener('wacrm-install-available', onInstallAvailable);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('wacrm-install-available', onInstallAvailable);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') {
      window.__wacrmInstallPrompt = undefined;
      setInstallPrompt(null);
    }
  };

  return (
    <section className="border-border bg-card mt-8 rounded-xl border p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="bg-primary-soft text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Smartphone className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground text-sm font-semibold">
            {t('installTitle')}
          </h3>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm leading-relaxed">
            {t('installDescription')}
          </p>

          {isStandalone ? (
            <div className="bg-primary-soft text-primary mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium">
              <CheckCircle2 className="size-4" />
              {t('installed')}
            </div>
          ) : installPrompt ? (
            <Button className="mt-4" onClick={() => void install()}>
              <Download className="size-4" />
              {t('installButton')}
            </Button>
          ) : isIOS ? (
            <div className="bg-muted text-foreground mt-4 flex items-start gap-2 rounded-lg p-3 text-sm">
              <Share2 className="text-primary mt-0.5 size-4 shrink-0" />
              <p>{t('installIOS')}</p>
            </div>
          ) : (
            <p className="text-muted-foreground mt-4 text-sm">
              {t('installBrowserMenu')}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
