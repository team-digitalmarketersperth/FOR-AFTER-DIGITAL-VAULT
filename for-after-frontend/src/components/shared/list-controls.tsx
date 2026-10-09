'use client';

import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toQuery, type Pagination } from '@/lib/api/admin';

// URL-driven list controls: filters and page live in the query string, the
// API does the filtering and paging. Used by the admin lists and Memory Vault.

const SEARCH_DELAY_MS = 350;

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

/**
 * Server-side search after a short pause in typing (trimmed; blank = none).
 * Back/forward restore the box from the URL.
 */
export function SearchBox({
  value,
  onSearch,
  placeholder,
  maxLength,
  label = 'Search',
}: {
  value?: string;
  onSearch: (search?: string) => void;
  placeholder: string;
  maxLength: number;
  label?: string;
}) {
  const [text, setText] = useState(value ?? '');
  const pushed = useRef(value);
  useEffect(() => {
    if (value === pushed.current) return;
    pushed.current = value;
    setText(value ?? '');
  }, [value]);
  const latest = useRef(onSearch);
  useEffect(() => {
    latest.current = onSearch;
  });
  useEffect(() => {
    const next = text.trim() || undefined;
    if (next === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = next;
      latest.current(next);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div className="grid gap-2">
      <Label htmlFor="search">{label}</Label>
      <div className="relative">
        <Search aria-hidden strokeWidth={1.5} className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-muted" />
        <Input
          id="search"
          type="search"
          value={text}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          className="h-11 pl-9"
        />
      </div>
    </div>
  );
}

