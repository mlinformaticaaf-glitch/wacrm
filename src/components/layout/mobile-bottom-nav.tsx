'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ContactRound,
  GitBranch,
  LayoutDashboard,
  Menu,
  MessageSquare,
} from 'lucide-react';

import { useTotalUnread } from '@/hooks/use-total-unread';
import { cn } from '@/lib/utils';

const primaryItems = [
  { href: '/dashboard', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/inbox', labelKey: 'inbox', icon: MessageSquare },
  { href: '/contacts', labelKey: 'contacts', icon: ContactRound },
  { href: '/pipelines', labelKey: 'pipelines', icon: GitBranch },
] as const;

export function MobileBottomNav({ onOpenMenu }: { onOpenMenu: () => void }) {
  const pathname = usePathname();
  const t = useTranslations('Sidebar');
  const unread = useTotalUnread();
  const primaryPathActive = primaryItems.some(
    ({ href }) => pathname === href || pathname.startsWith(`${href}/`)
  );

  return (
    <nav
      aria-label={t('mobileNavigation')}
      className="border-border bg-card/95 z-20 grid shrink-0 grid-cols-5 border-t px-[max(0.35rem,env(safe-area-inset-left))] pt-1 pb-[max(0.35rem,env(safe-area-inset-bottom))] supports-backdrop-filter:backdrop-blur-md lg:hidden"
    >
      {primaryItems.map(({ href, labelKey, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[10px] font-medium transition-colors',
              active
                ? 'bg-primary-soft text-primary'
                : 'text-muted-foreground active:bg-muted active:text-foreground'
            )}
          >
            <span className="relative">
              <Icon className="size-5" />
              {href === '/inbox' && unread > 0 ? (
                <span className="bg-primary text-primary-foreground absolute -top-1.5 -right-2 flex min-w-4 items-center justify-center rounded-full px-1 text-[9px] leading-4 font-bold">
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}
            </span>
            <span className="max-w-full truncate">{t(labelKey)}</span>
          </Link>
        );
      })}

      <button
        type="button"
        onClick={onOpenMenu}
        aria-label={t('more')}
        className={cn(
          'flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[10px] font-medium transition-colors',
          primaryPathActive
            ? 'text-muted-foreground active:bg-muted active:text-foreground'
            : 'bg-primary-soft text-primary'
        )}
      >
        <Menu className="size-5" />
        <span>{t('more')}</span>
      </button>
    </nav>
  );
}
