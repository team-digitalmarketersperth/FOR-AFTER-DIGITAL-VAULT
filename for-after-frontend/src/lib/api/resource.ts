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
