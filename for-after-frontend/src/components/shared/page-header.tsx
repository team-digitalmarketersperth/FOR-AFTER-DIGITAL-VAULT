import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Every Step 18 page opens with this: optional back link, eyebrow, Cormorant h1, intro, action. */
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  back,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-10 grid gap-4 lg:mb-12">
      {back && (
        <Link
          href={back.href}
          className="inline-flex w-fit items-center gap-2 rounded-sm text-sm text-foreground-muted outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ArrowLeft aria-hidden strokeWidth={1.5} className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-3">
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1 className="text-[40px] leading-[1.05] break-words sm:text-5xl">{title}</h1>
          {description && <p className="max-w-2xl text-lg text-foreground-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </header>
  );
}
