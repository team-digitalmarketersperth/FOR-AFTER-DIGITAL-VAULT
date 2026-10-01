import type { ReactNode } from 'react';

export function AuthHeading({ title, description }: { title: ReactNode; description: string }) {
  return (
    <div className="mb-8 grid gap-3">
      <h1 className="text-[44px] leading-[1.02]">{title}</h1>
      <p className="text-foreground-muted">{description}</p>
    </div>
  );
}
