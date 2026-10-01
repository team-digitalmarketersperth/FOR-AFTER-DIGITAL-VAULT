'use client';

import { useCurrentUser } from '@/hooks/use-auth';

// Rendered inside CustomerGate, so auth/me is already cached.
export function Greeting() {
  const { data: user } = useCurrentUser();
  return (
    <h1 className="text-[44px] leading-[1.02] sm:text-[56px]">
      Welcome back{user && <>, <em>{user.firstName}</em></>}.
    </h1>
  );
}
