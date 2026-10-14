'use client';

import { useEffect } from 'react';

declare global {
  interface Window {
    __wacrmInstallPrompt?: Event;
  }
}

export function PwaRegistration() {
  useEffect(() => {
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault();
      window.__wacrmInstallPrompt = event;
      window.dispatchEvent(new Event('wacrm-install-available'));
    };
    window.addEventListener('beforeinstallprompt', captureInstallPrompt);

    if (!('serviceWorker' in navigator)) {
      return () =>
        window.removeEventListener('beforeinstallprompt', captureInstallPrompt);
    }

    const register = () => {
      void navigator.serviceWorker
        .register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        })
        .catch(() => undefined);
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });

    return () => {
      window.removeEventListener('load', register);
      window.removeEventListener('beforeinstallprompt', captureInstallPrompt);
    };
  }, []);

  return null;
}
