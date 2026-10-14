import sharp from 'sharp';

const svg = (size, padding = Math.round(size * 0.2)) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#25d366"/>
  <g transform="translate(${padding} ${padding}) scale(${(size - padding * 2) / 24})" fill="none" stroke="#062b17" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </g>
</svg>`;

const outputs = [
  [192, 'public/pwa-192x192.png', 0.2],
  [512, 'public/pwa-512x512.png', 0.2],
  [512, 'public/pwa-maskable-512x512.png', 0.28],
  [180, 'public/apple-touch-icon.png', 0.2],
];

await Promise.all(
  outputs.map(([size, path, paddingRatio]) =>
    sharp(Buffer.from(svg(size, Math.round(size * paddingRatio))))
      .png()
      .toFile(path)
  )
);
