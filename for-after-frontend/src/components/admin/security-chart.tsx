'use client';

import { useId, useState, type PointerEvent } from 'react';
import type { SecuritySeries } from '@/lib/api/admin';
import { cn } from '@/lib/utils';

const PLUM = 'var(--chart-sign-in)';
const RED = 'var(--chart-failure)';
const SERIES = [
  { key: 'signIn', label: 'Admin sign-in and sign-out events', color: PLUM, dash: undefined },
  { key: 'mfaFailure', label: 'Admin two-factor failures', color: RED, dash: '5 4' },
] as const;

/** Bins are wall-clock text in the requested zone: read as written, never shifted by the browser's. */
const binDate = (bin: string) => {
  const [y, m, d, hh, mm] = bin.split(/\D/).map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, hh, mm));
};
const format = (bin: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-AU', { ...opts, timeZone: 'UTC' }).format(binDate(bin));
const axisLabel = (bin: string, unit: SecuritySeries['unit']) =>
  unit === 'hour' ? format(bin, { hour: 'numeric', hour12: true }) : format(bin, { day: '2-digit', month: 'short' });
const fullLabel = (bin: string, unit: SecuritySeries['unit']) =>
  unit === 'hour'
    ? format(bin, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', hour12: true })
    : format(bin, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/** Whole-number axis: counts of rows have no fractions. */
function yTicks(max: number) {
  const step = Math.max(1, ...[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].filter((s) => s * 5 <= max + s));
  const ticks: number[] = [];
  for (let v = 0; ; v += step) {
    ticks.push(v);
    if (v >= max) return ticks;
  }
}

/**
 * Stored audit rows per day or hour, as the API counted them. Lines join the
 * actual counts in order, with no smoothing, and no request telemetry is mixed in.
 */
export function SecurityChart({ series }: { series: SecuritySeries }) {
  const { bins, unit, timeZone } = series;
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const totals = SERIES.map((s) => bins.reduce((n, b) => n + b[s.key], 0));
  const per = unit === 'hour' ? 'hour' : 'day';

  if (bins.length === 0 || totals.every((t) => t === 0)) {
    return (
      <p className="rounded-lg bg-surface-muted px-4 py-6 text-sm text-foreground-secondary">
        No admin sign-in, sign-out or two-factor failure rows were recorded in this period. That only describes these
        event types; it doesn’t show nothing was attempted.
      </p>
    );
  }

  const ticks = yTicks(Math.max(1, ...bins.flatMap((b) => [b.signIn, b.mfaFailure])));
  const yMax = ticks.at(-1)!;
  const x = (i: number) => (bins.length === 1 ? 50 : (i / (bins.length - 1)) * 100);
  const y = (v: number) => 100 - (v / yMax) * 100;
  const xTickCount = Math.min(bins.length, 5);
  const xTicks = [...new Set(Array.from({ length: xTickCount }, (_, i) => (xTickCount === 1 ? 0 : Math.round((i * (bins.length - 1)) / (xTickCount - 1)))))];
  const hover = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setActive(bins.length === 1 ? 0 : Math.round(((e.clientX - r.left) / r.width) * (bins.length - 1)));
  };
  const point = active === null ? null : bins[active];

  return (
    <div className="grid min-w-0 gap-4">
      <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-foreground-secondary">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <svg aria-hidden width="24" height="8" className="shrink-0">
              <line x1="0" y1="4" x2="24" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} />
            </svg>
            {s.label}
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2">
        <div aria-hidden className="relative h-56 text-xs text-foreground-muted tabular-nums">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${y(t)}%` }}>
              {t.toLocaleString('en-AU')}
            </span>
          ))}
        </div>
        <div
          role="img"
          aria-label={`Recorded rows per ${per}, ${timeZone}. ${SERIES.map((s, i) => `${s.label}: ${totals[i]!.toLocaleString('en-AU')} in total`).join('. ')}. Exact counts are in the table below.`}
          className="relative h-56 touch-pan-y"
          onPointerMove={hover}
          onPointerDown={hover}
          onPointerLeave={() => setActive(null)}
        >
          <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
            {ticks.map((t) => (
              <line key={t} x1="0" x2="100" y1={y(t)} y2={y(t)} stroke="var(--border)" vectorEffect="non-scaling-stroke" />
            ))}
            {SERIES.map((s) => (
              <polyline
                key={s.key}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeDasharray={s.dash}
                vectorEffect="non-scaling-stroke"
                points={bins.map((b, i) => `${x(i)},${y(b[s.key])}`).join(' ')}
              />
            ))}
          </svg>
          {/* Real points stay visible when there are few; with many, only the hovered one. */}
          {SERIES.flatMap((s) =>
            bins.map((b, i) =>
              bins.length <= 14 || active === i ? (
                <span
                  key={`${s.key}-${b.bin}`}
                  aria-hidden
                  className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface"
                  style={{ left: `${x(i)}%`, top: `${y(b[s.key])}%`, background: s.color }}
                />
              ) : null,
            ),
          )}
          {point && active !== null && (
            <>
              <span aria-hidden className="absolute inset-y-0 w-px bg-border-strong" style={{ left: `${x(active)}%` }} />
              <div
                aria-hidden
                className={cn(
                  'pointer-events-none absolute top-2 z-10 grid w-max max-w-56 gap-1 rounded-lg border border-border bg-surface p-3 text-xs shadow-menu',
                  x(active) > 55 ? '-translate-x-full -ml-3' : 'ml-3',
                )}
                style={{ left: `${x(active)}%` }}
              >
                <span className="font-medium text-foreground">{fullLabel(point.bin, unit)}</span>
                {SERIES.map((s) => (
                  <span key={s.key} className="flex items-start gap-2 text-foreground-secondary">
                    <span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span>
                      {s.label}: <span className="font-medium text-foreground tabular-nums">{point[s.key].toLocaleString('en-AU')}</span>
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
        <span />
        <div aria-hidden className="relative mt-2 h-4 text-xs text-foreground-muted">
          {xTicks.map((i, k) => (
            <span
              key={i}
              // Phones: alternate labels only, so five dates never collide.
              className={cn('absolute whitespace-nowrap', k % 2 === 1 && 'max-sm:hidden', i === 0 && bins.length > 1 ? '' : i === bins.length - 1 && bins.length > 1 ? '-translate-x-full' : '-translate-x-1/2')}
              style={{ left: `${x(i)}%` }}
            >
              {axisLabel(bins[i]!.bin, unit)}
            </span>
          ))}
        </div>
      </div>
      <p className="text-xs text-foreground-muted">
        Stored audit rows per {per}, {timeZone} time. A zero means no rows of that type were stored, not that nothing was attempted.
      </p>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer rounded-sm font-medium text-primary outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring">
          View as a table
        </summary>
        <div id={tableId} className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">Recorded rows per {per}</caption>
            <thead className="sticky top-0 bg-surface-muted text-left text-xs text-foreground-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{unit === 'hour' ? 'Hour' : 'Day'}</th>
                <th scope="col" className="px-3 py-2 font-medium">Sign-in and sign-out</th>
                <th scope="col" className="px-3 py-2 font-medium">Two-factor failures</th>
              </tr>
            </thead>
            <tbody>
              {bins.map((b) => (
                <tr key={b.bin} className="border-t border-border">
                  <th scope="row" className="px-3 py-2 text-left font-normal">{fullLabel(b.bin, unit)}</th>
                  <td className="px-3 py-2 tabular-nums">{b.signIn.toLocaleString('en-AU')}</td>
                  <td className="px-3 py-2 tabular-nums">{b.mfaFailure.toLocaleString('en-AU')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
