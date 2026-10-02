'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, type ComponentProps, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { toQuery, type Pagination } from '@/lib/api/admin';
import type { UserRole, UserStatus } from '@/lib/api/auth';
import type { CaseStatus } from '@/lib/api/portals';
import { ROLE_LABEL, STATUS_LABEL } from '@/lib/admin';
import { ADMIN_STATUS } from '@/lib/death-verification';
import { cn } from '@/lib/utils';

// Small building blocks shared by the admin pages. Admin screens are denser
// than the Customer app, but use the same tokens, type and quiet surfaces.

export const linkClass =
  'rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-ring';

type Tone = 'neutral' | 'open' | 'done' | 'warning' | 'danger';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'border border-border bg-surface-muted text-foreground-secondary',
        tone === 'open' && 'bg-primary-soft text-primary',
        tone === 'done' && 'bg-success/10 text-success',
        tone === 'warning' && 'bg-warning/10 text-warning',
        tone === 'danger' && 'bg-danger/10 text-danger',
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<UserStatus, Tone> = { ACTIVE: 'done', SUSPENDED: 'warning', PASSED: 'neutral', DELETED: 'danger' };

export const UserStatusBadge = ({ status }: { status: UserStatus }) => (
  <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
);

export const RoleBadge = ({ role }: { role: UserRole }) => (
  <Badge tone={role === 'CUSTOMER' ? 'neutral' : 'open'}>{ROLE_LABEL[role]}</Badge>
);

export function CaseStatusBadge({ status }: { status: CaseStatus }) {
  const s = ADMIN_STATUS[status];
  const tone: Tone = status === 'READY_FOR_REVIEW' ? 'warning' : s.tone === 'closed' ? 'neutral' : s.tone;
  return <Badge tone={tone}>{s.label}</Badge>;
}

export type Column<T> = { header: string; cell: (row: T) => ReactNode; className?: string };

/**
 * A real <table> (caption, column headers) from md up; below that each row
 * stacks into a card with its column name beside each value, so nothing
 * scrolls sideways on a phone.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
}) {
  return (
    <div className="md:overflow-hidden md:rounded-lg md:border md:border-border md:bg-surface">
      <table className="block w-full text-sm md:table">
        <caption className="sr-only">{caption}</caption>
        <thead className="hidden bg-surface-muted md:table-header-group">
          <tr>
            {columns.map((c) => (
              <th
                key={c.header}
                scope="col"
                className="px-4 py-3 text-left text-xs font-medium tracking-wide text-foreground-muted uppercase"
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="grid gap-3 md:table-row-group">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="grid gap-2 rounded-lg border border-border bg-surface p-4 md:table-row md:rounded-none md:border-0 md:border-t md:p-0"
            >
              {columns.map((c) => (
                <td key={c.header} className={cn('grid grid-cols-[7rem_1fr] gap-3 md:table-cell md:px-4 md:py-3 md:align-middle', c.className)}>
                  <span aria-hidden className="text-xs text-foreground-muted md:hidden">
                    {c.header}
                  </span>
                  <span className="min-w-0 break-words">{c.cell(row)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Previous / next over the API's own pages (never client-side paging). */
export function Pager({ pagination, hrefFor }: { pagination: Pagination; hrefFor: (page: number) => string }) {
  const { page, pages, total } = pagination;
  if (pages <= 1) return <p className="mt-4 text-sm text-foreground-muted">{resultCount(total)}</p>;
  const step = (to: number, label: string, icon: ReactNode, disabled: boolean) =>
    disabled ? (
      <span aria-disabled="true" className="inline-flex min-h-11 items-center gap-1 px-3 text-foreground-muted/60">
        {icon}
        {label}
      </span>
    ) : (
      <Link
        href={hrefFor(to)}
        scroll={false}
        className="inline-flex min-h-11 items-center gap-1 rounded-full border border-border bg-surface px-4 outline-none hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring"
      >
        {icon}
        {label}
      </Link>
    );
  return (
    <nav aria-label="Pagination" className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="text-foreground-muted">
        Page {page} of {pages} · {resultCount(total)}
      </p>
      <div className="flex gap-2">
        {step(page - 1, 'Previous', <ChevronLeft aria-hidden className="size-4" />, page <= 1)}
        {step(page + 1, 'Next', <ChevronRight aria-hidden className="size-4" />, page >= pages)}
      </div>
    </nav>
  );
}

const resultCount = (n: number) => `${n.toLocaleString('en-AU')} ${n === 1 ? 'result' : 'results'}`;

/**
 * Filters live in the URL (refresh, Back and shared links keep them). Changing
 * a filter replaces the history entry and goes back to page 1.
 */
export function useFilterNav<F extends Record<string, string | number | undefined>>(base: string, current: F) {
  const router = useRouter();
  const href = useCallback((next: Partial<F>) => `${base}${toQuery({ ...current, ...next })}`, [base, current]);
  const set = useCallback(
    (next: Partial<F>) => router.replace(href({ ...next, page: undefined } as Partial<F>), { scroll: false }),
    [router, href],
  );
  return { href, set };
}

export function SelectField({
  id,
  label,
  options,
  ...props
}: ComponentProps<'select'> & { id: string; label: string; options: { value: string; label: string }[] }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-11 rounded-sm border border-input bg-surface px-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Label/value pairs for detail pages. Values are rendered as text. `narrow` = one column (side panels). */
export function Facts({ items, narrow }: { items: [string, ReactNode][]; narrow?: boolean }) {
  return (
    <dl className={cn('grid gap-x-8 gap-y-4', !narrow && 'sm:grid-cols-2')}>
      {items.map(([label, value]) => (
        <div key={label} className="grid gap-1">
          <dt className="text-xs font-medium tracking-wide text-foreground-muted uppercase">{label}</dt>
          <dd className="min-w-0 break-words text-[15px] text-foreground">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Panel({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  const id = title ? `panel-${title.toLowerCase().replace(/\W+/g, '-')}` : undefined;
  return (
    <section aria-labelledby={id} className={cn('grid gap-5 rounded-xl border border-border bg-surface p-5 sm:p-7', className)}>
      {title && (
        <h2 id={id} className="text-2xl">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}
