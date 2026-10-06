import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { CurrentUser } from '@/lib/api/auth';
import { makeQueryClient } from '@/lib/query/query-client';

export const API = 'http://api.test/api/v1';

export const customer: CurrentUser = {
  id: 'u1',
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: 'CUSTOMER',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  twoFactorEnabled: false,
  createdAt: '2026-09-01T00:00:00.000Z',
};

/** The API's list envelope (Phase 09) for one page holding `items`. */
export const page = <T,>(items: T[], over: { page?: number; total?: number; pages?: number; limit?: number } = {}) => ({
  items,
  pagination: {
    page: over.page ?? 1,
    limit: over.limit ?? 25,
    total: over.total ?? items.length,
    pages: over.pages ?? (items.length ? 1 : 0),
  },
});

export const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Stubs global fetch (the network boundary) with queued responses. */
export function mockFetch(...responses: Array<Response | Promise<Response> | Error>) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockImplementationOnce(() => Promise.resolve(response));
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The app's real QueryClient, minus retry delays so failures surface at once. */
export function renderWithClient(ui: ReactElement) {
  const queryClient = makeQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  return { queryClient, ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>) };
}

export const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };

type Handler = Response | ((body: unknown, url: URL) => Response);

/**
 * Route-based fetch stub for screens that fire parallel requests. Keys are
 * "METHOD /path" (query string ignored; a handler can read `url`). Unmatched
 * requests fail loudly with 599 so a test can't pass by accident.
 */
export function routeFetch(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown; credentials?: RequestCredentials }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, credentials: init?.credentials });
    const handler = routes[`${method} ${path}`];
    if (!handler) return json(599, { message: `No test route for ${method} ${path}` });
    return typeof handler === 'function' ? handler(body, url) : handler.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  const called = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
  return { calls, called };
}

/** Browser → storage PUT stub: records requests, reports progress, then answers `status`. */
export function fakeStorage(status = 200) {
  const puts: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  class FakeXHR {
    upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    status = 0;
    private url = '';
    private headers: Record<string, string> = {};
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    abort() {
      this.onabort?.();
    }
    send(body: unknown) {
      puts.push({ url: this.url, headers: this.headers, body });
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
        this.status = status;
        if (status === 0) this.onerror?.();
        else this.onload?.();
      });
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  return puts;
}
