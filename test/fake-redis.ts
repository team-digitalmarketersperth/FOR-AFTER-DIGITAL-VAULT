// Just enough of node-redis for the OTP auth unit tests, with TTLs on a fake clock.
export const fakeRedis = () => {
  const store = new Map<string, unknown>();
  const ttl = new Map<string, number>();
  let clock = 0;
  const live = (k: string) => {
    if (ttl.has(k) && ttl.get(k)! <= clock) {
      store.delete(k);
      ttl.delete(k);
    }
    return store.get(k);
  };
  const ops = {
    hSet: (k: string, v: Record<string, unknown>) => {
      const h = (live(k) as Record<string, string>) ?? {};
      for (const [f, x] of Object.entries(v)) h[f] = String(x);
      store.set(k, h);
      return Object.keys(v).length;
    },
    hIncrBy: (k: string, f: string, n: number) => {
      const h = (live(k) as Record<string, string>) ?? {};
      h[f] = String(Number(h[f] ?? 0) + n);
      store.set(k, h);
      return Number(h[f]);
    },
    hGetAll: (k: string) => ({ ...(live(k) as object) }),
    incr: (k: string) => {
      const n = Number(live(k) ?? 0) + 1;
      store.set(k, n);
      return n;
    },
    expire: (k: string, s: number, mode?: string) => {
      if (mode === 'NX' && ttl.has(k)) return 0;
      ttl.set(k, clock + s * 1000);
      return 1;
    },
  };
  type Ops = typeof ops;
  const client = {
    get: vi.fn(async (k: string) => (live(k) as string) ?? null),
    hGetAll: vi.fn(async (k: string) => ops.hGetAll(k)),
    set: vi.fn(
      async (k: string, v: string, o: { expiration: { value: number } }) => {
        store.set(k, v);
        ttl.set(k, clock + o.expiration.value * 1000);
        return 'OK';
      },
    ),
    del: vi.fn(async (k: string) => {
      const had = live(k) !== undefined;
      store.delete(k);
      return had ? 1 : 0;
    }),
    multi: () => {
      const queued: (() => unknown)[] = [];
      const chain = new Proxy({} as Record<string, unknown>, {
        get: (_, name: string) =>
          name === 'exec'
            ? async () => queued.map((f) => f())
            : (...args: unknown[]) => {
                queued.push(() =>
                  (ops[name as keyof Ops] as (...a: unknown[]) => unknown)(
                    ...args,
                  ),
                );
                return chain;
              },
      });
      return chain;
    },
  };
  return {
    client,
    store,
    ttl,
    advance: (ms: number) => (clock += ms),
  };
};
