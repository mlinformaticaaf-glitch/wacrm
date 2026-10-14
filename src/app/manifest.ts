import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'WACRM — CRM para WhatsApp',
    short_name: 'WACRM',
    description: 'Atendimento, contatos e vendas pelo WhatsApp em um só lugar.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#07140d',
    theme_color: '#25d366',
    lang: 'pt-BR',
    categories: ['business', 'productivity'],
    icons: [
      {
        src: '/pwa-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa-maskable-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: 'Caixa de Entrada',
        short_name: 'Conversas',
        url: '/inbox',
        icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }],
      },
      {
        name: 'Contatos',
        short_name: 'Contatos',
        url: '/contacts',
        icons: [{ src: '/pwa-192x192.png', sizes: '192x192' }],
      },
    ],
  };
}
