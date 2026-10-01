// The one place the frontend reads its configuration. NEXT_PUBLIC_* values are
// inlined at build time, so they must be referenced literally (no dynamic keys).

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1'
).replace(/\/+$/, '');

export const APP_ENV = process.env.NEXT_PUBLIC_APP_ENV ?? 'development';

// Both must hold: a production build never serves /dev-login, whatever APP_ENV says.
export const isDevLoginEnabled = () =>
  process.env.NODE_ENV !== 'production' && APP_ENV === 'development';
