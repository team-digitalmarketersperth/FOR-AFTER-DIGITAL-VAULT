import { NextResponse } from 'next/server';
import { isDevLoginEnabled } from '@/lib/env';

// /dev-login must not exist outside local development (FE-7). Answering here,
// before rendering, gives a real 404 status; the page's own notFound() is the
// second line of defence.
export function proxy() {
  if (isDevLoginEnabled()) return NextResponse.next();
  return new NextResponse('Not Found', { status: 404 });
}

export const config = { matcher: '/dev-login' };
