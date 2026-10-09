'use client';

import type { ReactNode } from 'react';
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

// Shared with customer lists (Memory Vault); admin pages keep importing here.
export { Pager, SelectField, useFilterNav } from '@/components/shared/list-controls';

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
