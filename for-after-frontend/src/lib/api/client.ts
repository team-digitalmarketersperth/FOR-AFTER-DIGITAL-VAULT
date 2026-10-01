import { API_BASE_URL } from '@/lib/env';
import { networkError, toApiError } from './errors';

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * Every API call goes through here. Authentication is the NestJS HttpOnly
 * session cookie, sent by the browser because of `credentials: 'include'`;
 * the frontend never sees, stores or logs it.
 *
 * Resolves with the parsed JSON body (undefined for empty responses) or throws
 * an ApiError. AbortErrors are rethrown untouched so TanStack Query can cancel.
 */
export async function apiRequest<T>(
  path: string,
  { method = 'GET', body, signal }: RequestOptions = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw networkError();
  }

  const data = await readJson(response);
  if (!response.ok) throw toApiError(response.status, data);
  return data as T;
}

// 204s, empty bodies and non-JSON bodies (e.g. a proxy's HTML error page) all
// become undefined rather than a parse crash; the status decides what happens.
async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
