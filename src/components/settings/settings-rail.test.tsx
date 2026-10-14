import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { SettingsRail } from './settings-rail';
import { RAIL_GROUPS, SETTINGS_SECTIONS } from './settings-sections';

const messages = {
  Settings: {
    groups: Object.fromEntries(
      RAIL_GROUPS.map(({ group }) => [group, group]),
    ),
    sections: Object.fromEntries(
      SETTINGS_SECTIONS.map((section) => [section, section]),
    ),
  },
};

describe('SettingsRail', () => {
  it('renders every settings section as a navigable link', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider
        locale="pt-BR"
        messages={messages}
        timeZone="America/Sao_Paulo"
      >
        <SettingsRail active="whatsapp" />
      </NextIntlClientProvider>,
    );

    for (const section of SETTINGS_SECTIONS) {
      expect(html).toContain(`href="/settings?tab=${section}"`);
    }
    expect(html).toMatch(
      /aria-current="page"[^>]*href="\/settings\?tab=whatsapp"/,
    );
  });
});
