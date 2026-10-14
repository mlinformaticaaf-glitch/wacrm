/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require('playwright');
const os = require('node:os');
const path = require('node:path');

const baseUrl = process.env.TARGET_URL || 'http://localhost:3001';
const viewports = [
  { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: 'tablet', width: 768, height: 1024, isMobile: true, hasTouch: true },
  {
    name: 'desktop',
    width: 1440,
    height: 900,
    isMobile: false,
    hasTouch: false,
  },
];

(async () => {
  const browser = await chromium.launch({ headless: false });
  const results = [];

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile,
        hasTouch: viewport.hasTouch,
      });
      const page = await context.newPage();
      await page.addInitScript(() =>
        localStorage.setItem('wacrm.theme', 'violet')
      );
      const navigation = await page.goto(`${baseUrl}/login`, {
        waitUntil: 'domcontentloaded',
      });
      await page.locator('body').waitFor({ state: 'visible' });
      await page.waitForTimeout(1_000);

      if (!navigation?.ok()) {
        throw new Error(
          `${viewport.name}: login returned ${navigation?.status()} at ${page.url()}: ${(
            await page.locator('body').innerText()
          ).slice(0, 300)}`
        );
      }

      const state = await page.evaluate(() => ({
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        theme: document.documentElement.dataset.theme,
        manifest: document
          .querySelector('link[rel="manifest"]')
          ?.getAttribute('href'),
        appleIcon: document
          .querySelector('link[rel="apple-touch-icon"]')
          ?.getAttribute('href'),
        themeColors: Array.from(
          document.querySelectorAll('meta[name="theme-color"]')
        ).map((node) => node.getAttribute('content')),
      }));

      if (state.scrollWidth > state.width) {
        throw new Error(
          `${viewport.name}: horizontal overflow ${state.scrollWidth}/${state.width}`
        );
      }
      if (state.theme !== 'lime') {
        throw new Error(
          `${viewport.name}: expected lime theme, received ${state.theme}`
        );
      }
      if (!state.manifest || !state.appleIcon) {
        throw new Error(`${viewport.name}: PWA metadata is incomplete`);
      }

      const screenshot = path.join(os.tmpdir(), `wacrm-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      results.push({ viewport: viewport.name, screenshot, ...state });
      await context.close();
    }

    const response = await fetch(`${baseUrl}/manifest.webmanifest`);
    const manifest = await response.json();
    if (
      response.status !== 200 ||
      manifest.display !== 'standalone' ||
      !manifest.icons.some(
        (icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'
      )
    ) {
      throw new Error('Manifest validation failed');
    }

    const serviceWorker = await fetch(`${baseUrl}/sw.js`);
    if (serviceWorker.status !== 200)
      throw new Error('Service worker is unavailable');

    console.log(
      JSON.stringify(
        {
          manifest: response.status,
          serviceWorker: serviceWorker.status,
          results,
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
