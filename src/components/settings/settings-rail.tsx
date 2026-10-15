'use client';

import { type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import {
  RAIL_GROUPS,
  SECTION_META,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from './settings-sections';

/**
 * The settings navigation — grouped vertical rail on desktop and a compact
 * native selector on narrow screens. The selector avoids forcing phone users
 * to swipe through an extra-wide row before they can reach a distant section.
 */
export function SettingsRail({
  active,
  hints,
  onSelect,
}: {
  active: SettingsSection;
  hints?: Partial<Record<SettingsSection, ReactNode>>;
  onSelect?: (section: SettingsSection) => void;
}) {
  const t = useTranslations('Settings');

  return (
    <>
      <label className="block lg:hidden">
        <span className="sr-only">Settings sections</span>
        <select
          value={active}
          onChange={(event) => {
            const next = event.target.value as SettingsSection;
            if (onSelect) onSelect(next);
            else window.location.assign(`/settings?tab=${next}`);
          }}
          className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        >
          {SETTINGS_SECTIONS.map((section) => (
            <option key={section} value={section}>
              {t(`sections.${section}`)}
            </option>
          ))}
        </select>
      </label>
      <nav
        aria-label="Settings sections"
        className={cn(
          'hidden gap-1 border-b border-border pb-2',
          'lg:sticky lg:top-0 lg:flex lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0',
        )}
      >
      {RAIL_GROUPS.map(({ label, group }) => {
        const items = SETTINGS_SECTIONS.filter(
          (s) => SECTION_META[s].group === group,
        );
        return (
          <div
            key={group}
            className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5"
          >
            {label ? (
              <div className="hidden px-3 pt-3.5 pb-1.5 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase lg:block">
                {t(`groups.${group}`)}
              </div>
            ) : null}
            {items.map((s) => {
              const meta = SECTION_META[s];
              const Icon = meta.icon;
              const isActive = s === active;
              return (
                <Link
                  key={s}
                  href={`/settings?tab=${s}`}
                  replace
                  scroll={false}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors',
                    'lg:w-full',
                    isActive
                      ? 'bg-primary-soft text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1">{t(`sections.${s}`)}</span>
                  {hints?.[s] != null ? (
                    <span
                      className={cn(
                        'hidden items-center gap-1.5 text-xs lg:inline-flex',
                        isActive ? 'text-primary' : 'text-muted-foreground',
                      )}
                    >
                      {hints[s]}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        );
      })}
      </nav>
    </>
  );
}
