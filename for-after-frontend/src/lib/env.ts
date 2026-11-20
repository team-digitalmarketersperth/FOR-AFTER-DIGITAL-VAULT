// The one place the frontend reads its configuration. NEXT_PUBLIC_* values are
// inlined at build time, so they must be referenced literally (no dynamic keys).

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1'
).replace(/\/+$/, '');

export const APP_ENV = process.env.NEXT_PUBLIC_APP_ENV ?? 'development';

// The marketing site's pricing page, for the plan page's one "Compare plans" link. No verified URL exists yet, so it
// is unset by default and the link is hidden; only an https URL is used. Read at call time so tests can stub it.
export const plansUrl = () => {
  const url = process.env.NEXT_PUBLIC_PLANS_URL ?? '';
  return /^https:\/\/[^\s/]+/.test(url) ? url : null;
};

// Both must hold: a production build never serves /dev-login, whatever APP_ENV says.
export const isDevLoginEnabled = () =>
  process.env.NODE_ENV !== 'production' && APP_ENV === 'development';
