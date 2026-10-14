import { describe, expect, it } from 'vitest';

import manifest from './manifest';

describe('PWA manifest', () => {
  it('is installable and provides Android/iOS-sized icons', () => {
    const data = manifest();

    expect(data.display).toBe('standalone');
    expect(data.start_url).toBe('/dashboard');
    expect(data.theme_color).toBe('#25d366');
    expect(data.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: '192x192', type: 'image/png' }),
        expect.objectContaining({ sizes: '512x512', type: 'image/png' }),
        expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
      ])
    );
  });
});
