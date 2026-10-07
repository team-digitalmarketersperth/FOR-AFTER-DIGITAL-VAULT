import { apiRequest } from './client';

/** CRUD for an owner-scoped collection (the session user is always the owner). */
export function resource<T, Input>(base: string) {
  return {
    list: (signal?: AbortSignal) => apiRequest<T[]>(base, { signal }),
    get: (id: string, signal?: AbortSignal) => apiRequest<T>(`${base}/${id}`, { signal }),
    create: (input: Input) => apiRequest<T>(base, { method: 'POST', body: input }),
    update: (id: string, input: Partial<Input>) =>
      apiRequest<T>(`${base}/${id}`, { method: 'PATCH', body: input }),
    remove: (id: string) => apiRequest<void>(`${base}/${id}`, { method: 'DELETE' }),
  };
}

/** Every item of a paginated list (`?page&limit`, the API's PageQueryDto): pages of 100, its maximum, until the last. */
export async function allPages<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const res = await apiRequest<{ items: T[]; pagination: { pages: number } }>(`${path}?page=${page}&limit=100`, { signal });
    items.push(...res.items);
    if (page >= res.pagination.pages) return items;
  }
}
