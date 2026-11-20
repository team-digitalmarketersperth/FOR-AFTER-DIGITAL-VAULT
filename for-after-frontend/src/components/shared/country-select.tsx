'use client';

import { Check, ChevronDown } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { COUNTRIES, countryLabel, findCountry, type Country } from '@/lib/phone';
import { cn } from '@/lib/utils';

const matches = (c: Country, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/^\+/, '');
  return c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q || (/^\d+$/.test(digits) && c.dial.slice(1).startsWith(digits));
};

/**
 * Searchable country + calling code picker (WAI-ARIA combobox with a listbox):
 * type a name, "AU" or "+61"; ↑/↓, Home/End move; Enter picks; Esc closes and
 * focus returns to the button. Countries sharing a code are listed separately.
 */
export function CountrySelect({
  id,
  value,
  onChange,
  label,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (code: string) => void;
  /** What the country is for, e.g. "Country for mobile". */
  label: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const selected = findCountry(value);
  const list = COUNTRIES.filter((c) => matches(c, query));
  const activeCountry = list[Math.min(active, list.length - 1)];
  const optionId = (c: Country) => `${id}-option-${c.code}`;

  useEffect(() => {
    if (open && activeCountry) document.getElementById(optionId(activeCountry))?.scrollIntoView?.({ block: 'nearest' });
  });

  const choose = (c: Country) => {
    onChange(c.code);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = list.length - 1;
    const move: Record<string, number> = { ArrowDown: Math.min(active + 1, last), ArrowUp: Math.max(active - 1, 0), PageDown: Math.min(active + 10, last), PageUp: Math.max(active - 10, 0), Home: 0, End: last };
    if (e.key in move) {
      e.preventDefault();
      setActive(Math.max(move[e.key], 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeCountry) choose(activeCountry);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery('');
          setActive(Math.max(COUNTRIES.findIndex((c) => c.code === value), 0));
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          id={id}
          aria-label={`${label}: ${selected ? countryLabel(selected) : 'not chosen'}`}
          aria-describedby={describedBy}
          className={cn(
            'flex h-11 w-full min-w-0 items-center justify-between gap-2 rounded-sm border border-input bg-surface px-3 text-left text-base text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60',
            invalid && 'border-destructive ring-3 ring-destructive/15',
          )}
        >
          <span className={cn('truncate', !selected && 'text-foreground-muted')}>
            {selected ? countryLabel(selected) : 'Choose country'}
          </span>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-foreground-muted" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={16}
          className="z-50 grid w-[min(22rem,calc(100vw-2rem))] gap-2 rounded-md border border-border bg-surface p-2 shadow-lg"
        >
          <input
            type="text"
            role="combobox"
            aria-label="Search countries"
            aria-expanded
            aria-controls={`${id}-listbox`}
            aria-autocomplete="list"
            aria-activedescendant={activeCountry ? optionId(activeCountry) : undefined}
            autoComplete="off"
            placeholder="Search country or code"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="h-11 w-full min-w-0 rounded-sm border border-input bg-surface px-3 text-base outline-none placeholder:text-foreground-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/15"
          />
          <ul id={`${id}-listbox`} role="listbox" aria-label="Countries" className="max-h-64 overflow-y-auto overscroll-contain">
            {list.map((c) => (
              <li
                key={c.code}
                id={optionId(c)}
                role="option"
                aria-selected={c.code === value}
                onPointerMove={() => setActive(list.indexOf(c))}
                onClick={() => choose(c)}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-3 py-2 text-sm',
                  c === activeCountry && 'bg-primary-soft',
                )}
              >
                <Check aria-hidden className={cn('size-4 shrink-0', c.code !== value && 'invisible')} />
                <span className="flex-1">{c.name}</span>
                <span className="text-foreground-muted tabular-nums">{c.dial}</span>
              </li>
            ))}
          </ul>
          {list.length === 0 && (
            <p role="status" className="px-3 py-2 text-sm text-foreground-muted">
              No country matches “{query.trim()}”.
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
