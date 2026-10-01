export type ApiErrorKind =
  | 'validation' // 400
  | 'unauthenticated' // 401
  | 'forbidden' // 403
  | 'not_found' // 404
  | 'conflict' // 409
  | 'rate_limited' // 429
  | 'server' // 5xx
  | 'network' // no response at all
  | 'unknown'; // any other status

/**
 * The only error shape components see. `message` is always safe to render: it is
 * either a fixed string below or a plain-text NestJS message (never headers,
 * stack traces or raw bodies). `details` holds per-field validation messages.
 */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number | null,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const DEFAULT_MESSAGES: Record<ApiErrorKind, string> = {
  validation: 'Please check the details you entered.',
  unauthenticated: 'Please sign in to continue.',
  forbidden: "You don't have permission to access this page.",
  not_found: "We couldn't find what you were looking for.",
  conflict: 'This conflicts with something that already exists.',
  rate_limited: 'Too many attempts. Please try again shortly.',
  server: 'Something went wrong on our side. Please try again.',
  network: "We couldn't connect to For After. Please try again.",
  unknown: 'Something went wrong. Please try again.',
};

// Backend messages are only shown for statuses where NestJS returns deliberate,
// user-facing text; 429 and 5xx always get the fixed copy.
const TRUST_BACKEND_MESSAGE = new Set<ApiErrorKind>([
  'validation',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
]);

// NestJS falls back to the HTTP reason phrase when a handler sets no message
// ("Forbidden resource" is what a guard returning false produces).
const REASON_PHRASES = new Set([
  'Bad Request',
  'Unauthorized',
  'Forbidden',
  'Forbidden resource',
  'Not Found',
  'Conflict',
]);

function kindFor(status: number): ApiErrorKind {
  if (status === 400) return 'validation';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'unknown';
}

const safeText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 500;

/** Maps an error response body (untrusted, any shape) to an ApiError. */
export function toApiError(status: number, body: unknown): ApiError {
  const kind = kindFor(status);
  const raw =
    body && typeof body === 'object' && 'message' in body
      ? body.message
      : undefined;
  // NestJS validation errors: message is string[]; everything else: string.
  const messages = (Array.isArray(raw) ? raw : [raw])
    .filter(safeText)
    .filter((m) => !REASON_PHRASES.has(m));

  if (!TRUST_BACKEND_MESSAGE.has(kind) || messages.length === 0) {
    return new ApiError(kind, status, DEFAULT_MESSAGES[kind]);
  }
  if (messages.length > 1) {
    return new ApiError(kind, status, DEFAULT_MESSAGES[kind], messages);
  }
  return new ApiError(kind, status, messages[0]);
}

export const networkError = () =>
  new ApiError('network', null, DEFAULT_MESSAGES.network);

export const isApiError = (error: unknown): error is ApiError =>
  error instanceof ApiError;

/** For any caught value: a safe message, never a stack or object dump. */
export const errorMessage = (error: unknown) =>
  isApiError(error) ? error.message : DEFAULT_MESSAGES.unknown;
