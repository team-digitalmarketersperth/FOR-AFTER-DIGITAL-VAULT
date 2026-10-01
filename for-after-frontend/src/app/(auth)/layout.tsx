import Image from 'next/image';
import type { ReactNode } from 'react';
import { GuestGate } from '@/components/auth/auth-gates';
import { BrandLogo } from '@/components/layout/brand-logo';

// Split layout echoing the WordPress hero: the site's own photography and
// taglines on the left (desktop), a calm form column on the right.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden overflow-hidden lg:block">
        <Image
          src="/brand/together.webp"
          alt=""
          fill
          priority
          sizes="50vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/25 to-black/10" />
        <div className="relative flex h-full flex-col justify-between p-12 text-white">
          <BrandLogo href="/login" tone="light" className="h-10" />
          <div className="grid max-w-md gap-4">
            <p className="font-heading text-5xl leading-[1.02] tracking-tight">
              Leave what matters, <em>for the ones you love.</em>
            </p>
            <p className="text-sm text-white/85">Your words. Your memories. Always theirs.</p>
          </div>
        </div>
      </aside>

      <main className="flex flex-col px-5 py-8 sm:px-10 lg:px-16">
        <BrandLogo href="/login" className="h-8 lg:hidden" />
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[26rem]">
            <GuestGate>{children}</GuestGate>
          </div>
        </div>
      </main>
    </div>
  );
}
