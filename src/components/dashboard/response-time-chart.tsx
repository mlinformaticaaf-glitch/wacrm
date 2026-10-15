'use client';

import { Clock } from 'lucide-react';
import type { ResponseTimeSummary } from '@/lib/dashboard/types';
import { BarChart } from '@/components/tremor/bar-chart';
import { EmptyState } from './empty-state';
import { Skeleton } from './skeleton';

interface ResponseTimeChartProps {
  data: ResponseTimeSummary | null;
  loading: boolean;
  /** Minutes. Surfaced as a "target" pill in the header. The
   *  hand-rolled SVG version drew this as a horizontal dashed
   *  line on the chart; Tremor BarChart doesn't expose Recharts
   *  primitives, so we promote it to the header for now. A
   *  follow-up can introduce an overlay or extend the vendored
   *  BarChart with a `referenceLines` prop. */
  thresholdMinutes?: number;
}

import { useLocale, useTranslations } from 'next-intl';

export function ResponseTimeChart({
  data,
  loading,
  thresholdMinutes = 5,
}: ResponseTimeChartProps) {
  const t = useTranslations('Dashboard.responseTimeChart');
  const locale = useLocale();
  const category = t('averageMinutes');
  const hasData = data?.buckets.some((b) => b.avgMinutes != null) ?? false;

  // 2024-01-01 was a Monday. Formatting these seven stable dates keeps
  // the axis and tooltip in the active locale without timezone drift.
  const weekdayLabels = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short' })
      .format(new Date(2024, 0, 1 + i))
      .replace(/\.$/, ''),
  );

  // Map buckets → Tremor rows. Null `avgMinutes` (no samples)
  // collapses to 0; the chart will render an empty slot for it.
  // We attach `samples` on the row so a future customTooltip can
  // surface "no samples" copy without losing the data shape.
  const chartData =
    data?.buckets.map((b, i) => ({
      day: weekdayLabels[i],
      [category]: b.avgMinutes ?? 0,
      samples: b.samples,
    })) ?? [];

  return (
    <section className="border-border bg-card rounded-xl border">
      <header className="border-border flex flex-col items-start gap-4 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0">
          <h2 className="text-foreground text-sm font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t('description')}
          </p>
        </div>
        <div className="grid w-full grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-stretch gap-2 text-xs sm:w-auto sm:min-w-[19rem]">
          {thresholdMinutes > 0 && (
            <span className="self-center whitespace-nowrap rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-center font-medium text-rose-300 tabular-nums">
              {t('target', { minutes: thresholdMinutes })}
            </span>
          )}
          {data && (data.thisWeekAvg != null || data.lastWeekAvg != null) && (
            <>
              <div className="rounded-lg bg-muted/50 px-2.5 py-2 text-left">
                <span className="block leading-tight text-muted-foreground">
                  {t('thisWeek')}
                </span>
                <strong className="mt-1 block font-semibold text-foreground tabular-nums">
                  {fmt(data.thisWeekAvg)}
                </strong>
              </div>
              <div className="rounded-lg bg-muted/50 px-2.5 py-2 text-left">
                <span className="block leading-tight text-muted-foreground">
                  {t('lastWeek')}
                </span>
                <strong className="mt-1 block font-semibold text-foreground tabular-nums">
                  {fmt(data.lastWeekAvg)}
                </strong>
              </div>
            </>
          )}
        </div>
      </header>

      <div className="p-3 sm:p-5">
        {loading || !data ? (
          <Skeleton className="h-[260px] w-full" />
        ) : !hasData ? (
          <EmptyState
            icon={Clock}
            title={t('noReplies')}
            hint={t('noRepliesHint')}
          />
        ) : (
          <BarChart
            data={chartData}
            index="day"
            categories={[category]}
            colors={['lime']}
            valueFormatter={formatMinutes}
            showLegend={false}
            yAxisWidth={48}
            // Compact height so the chart sits well inside the card
            // without dominating the row alongside the donut + activity feed.
            className="h-[260px] [&_.recharts-cartesian-axis-tick-value]:fill-muted-foreground"
          />
        )}
      </div>
    </section>
  );
}

function fmt(mins: number | null): string {
  if (mins == null) return '—';
  return formatMinutes(mins);
}

function formatMinutes(mins: number): string {
  if (mins <= 0) return '0s';
  if (mins < 1) return `${Math.max(1, Math.round(mins * 60))}s`;
  if (mins < 60) return `${mins.toFixed(1)}m`;
  return `${(mins / 60).toFixed(1)}h`;
}
