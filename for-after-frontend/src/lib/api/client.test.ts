import { describe, expect, it, vi } from 'vitest';
import { API, json, mockFetch } from '@/test/utils';
import { makeQueryClient, queryKeys } from '@/lib/query/query-client';
import { apiRequest } from './client';
import { ApiError } from './errors';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error as ApiError,
  );

describe('apiRequest', () => {
  it('builds the URL from the base URL and always sends cookies', async () => {
    const fetchMock = mockFetch(json(200, { ok: true }));
    await expect(apiRequest('/auth/me')).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/auth/me`);
    expect(init?.credentials).toBe('include');
    expect(init?.method).toBe('GET');
  });

  it('sends JSON bodies with a JSON content type', async () => {
    const fetchMock = mockFetch(json(200, {}));
    await apiRequest('/auth/login', { method: 'POST', body: { email: 'a@b.co' } });
    const init = fetchMock.mock.calls[0][1];
    expect(init?.body).toBe('{"email":"a@b.co"}');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('resolves 204 and empty bodies to undefined', async () => {
    mockFetch(new Response(null, { status: 204 }), new Response('', { status: 200 }));
    await expect(apiRequest('/x')).resolves.toBeUndefined();
    await expect(apiRequest('/x')).resolves.toBeUndefined();
  });

  it.each([
    [401, { message: 'Invalid email or password.' }, 'unauthenticated', 'Invalid email or password.'],
    [401, { message: 'Unauthorized' }, 'unauthenticated', 'Please sign in to continue.'],
    [403, { message: 'This account cannot sign in.' }, 'forbidden', 'This account cannot sign in.'],
    [403, { message: 'Forbidden resource' }, 'forbidden', "You don't have permission to access this page."],
    [404, {}, 'not_found', "We couldn't find what you were looking for."],
    [409, { message: 'An account with this email already exists.' }, 'conflict', 'An account with this email already exists.'],
    [429, { message: 'ThrottlerException: Too Many Requests' }, 'rate_limited', 'Too many attempts. Please try again shortly.'],
    [500, { message: 'PrismaClientKnownRequestError: secret detail' }, 'server', 'Something went wrong on our side. Please try again.'],
    [502, undefined, 'server', 'Something went wrong on our side. Please try again.'],
  ])('maps %i to a safe %s error', async (status, body, kind, message) => {
    mockFetch(json(status, body));
    const error = await failure(apiRequest('/x'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind, status, message });
  });

  it('keeps NestJS validation messages as details, dropping non-strings', async () => {
    mockFetch(json(400, { message: ['email must be an email', { evil: true }, 'password too short'] }));
    const error = await failure(apiRequest('/x'));
    expect(error.kind).toBe('validation');
    expect(error.details).toEqual(['email must be an email', 'password too short']);
  });

  it('ignores non-JSON error bodies such as a proxy HTML page', async () => {
    mockFetch(new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await failure(apiRequest('/x'));
    expect(error.message).not.toContain('<html>');
  });

  it('turns a failed connection into a network error', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    const error = await failure(apiRequest('/x'));
    expect(error).toMatchObject({
      kind: 'network',
      status: null,
      message: "We couldn't connect to For After. Please try again.",
    });
  });

  it('rethrows aborts untouched so queries can cancel', async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(apiRequest('/x', { signal: controller.signal })).rejects.toBe(abort);
  });
});

describe('query retry policy', () => {
  const retry = makeQueryClient().getDefaultOptions().queries?.retry as (
    count: number,
    error: unknown,
  ) => boolean;

  it.each([400, 401, 403, 404, 409, 429])('never retries %i', (status) => {
    expect(retry(0, new ApiError('unknown', status, 'x'))).toBe(false);
  });

  it('retries server and network failures twice', () => {
    expect(retry(0, new ApiError('server', 500, 'x'))).toBe(true);
    expect(retry(1, new ApiError('network', null, 'x'))).toBe(true);
    expect(retry(2, new ApiError('server', 500, 'x'))).toBe(false);
  });
});

describe('session expiry', () => {
  it('a 401 from any feature call forgets private data and signs out', async () => {
    const client = makeQueryClient();
    client.setQueryData(queryKeys.me, { id: 'u1' });
    client.setQueryData(queryKeys.recipients, [{ id: 'r1', firstName: 'Private' }]);
    mockFetch(json(401, { statusCode: 401, message: 'Unauthorized' }));
    await client.fetchQuery({ queryKey: queryKeys.messages, queryFn: () => apiRequest('/messages') }).catch(() => undefined);
    await vi.waitFor(() => expect(client.getQueryData(queryKeys.me)).toBeNull());
    expect(client.getQueryData(queryKeys.recipients)).toBeUndefined();
  });
});
