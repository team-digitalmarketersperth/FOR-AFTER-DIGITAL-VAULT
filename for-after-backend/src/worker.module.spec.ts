import 'reflect-metadata';
import { AppModule } from './app.module.js';
import { DeathVerificationProcessor } from './death-verification/death-verification.processor.js';
import { MessageReleaseQueue } from './message-release/message-release-queue.service.js';
import { MessageReleaseReconciler } from './message-release/message-release-reconciler.service.js';
import { MessageReleaseProcessor } from './message-release/message-release.processor.js';
import { ReleaseNotificationQueue } from './release-notifications/release-notification-queue.service.js';
import { ReleaseNotificationProcessor } from './release-notifications/release-notification.processor.js';
import { DeathVerificationQueue } from './death-verification/death-verification-queue.service.js';
import { WorkerModule } from './worker.module.js';

type Mod = { module?: unknown; imports?: Mod[]; providers?: unknown[] } | Function;

// Everything a composition root reaches, read from module metadata (no boot).
const graph = (root: Mod) => {
  const seen = new Set<unknown>();
  const providers = new Set<unknown>();
  const controllers = new Set<unknown>();
  const visit = (m: Mod | undefined) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    const cls = typeof m === 'function' ? m : (m.module as Function);
    // forwardRef / async dynamic modules (e.g. ConfigModule.forRoot): not ours.
    if (typeof cls !== 'function') return;
    const meta = (key: string) =>
      (Reflect.getMetadata(key, cls) ?? []) as unknown[];
    const dyn = typeof m === 'function' ? {} : m;
    for (const p of [...meta('providers'), ...(dyn.providers ?? [])])
      providers.add((p as { provide?: unknown }).provide ?? p);
    for (const c of meta('controllers')) controllers.add(c);
    for (const i of [...meta('imports'), ...(dyn.imports ?? [])])
      visit(i as Mod);
    for (const e of meta('exports')) if (typeof e === 'function' && Reflect.getMetadata('imports', e)) visit(e as Mod);
  };
  visit(root);
  return { providers, controllers };
};

const CONSUMERS = [
  MessageReleaseProcessor,
  MessageReleaseReconciler,
  ReleaseNotificationProcessor,
  DeathVerificationProcessor,
];
const PRODUCERS = [MessageReleaseQueue, ReleaseNotificationQueue, DeathVerificationQueue];

describe('Phase 17B composition roots', () => {
  it('the API (AppModule) has every producer and no consumer or reconciler', () => {
    const { providers, controllers } = graph(AppModule);
    for (const c of CONSUMERS) expect(providers.has(c), c.name).toBe(false);
    for (const p of PRODUCERS) expect(providers.has(p), p.name).toBe(true);
    expect(controllers.size).toBeGreaterThan(0);
  });

  it('the worker (WorkerModule) has every consumer and reconciler, no controllers', () => {
    const { providers, controllers } = graph(WorkerModule);
    for (const c of CONSUMERS) expect(providers.has(c), c.name).toBe(true);
    expect([...controllers]).toEqual([]);
  });
});

describe('worker lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [
      'email-delivery',
      (reconcile: () => Promise<unknown>) => {
        const queue = { settings: { reconcileIntervalMs: 60_000 }, enqueueStale: reconcile };
        return new ReleaseNotificationProcessor({} as never, queue as never, {} as never, {} as never, {} as never);
      },
    ],
    [
      'death-verification',
      (reconcile: () => Promise<unknown>) =>
        new DeathVerificationProcessor(
          { reconcile } as never,
          { settings: { reconcileIntervalMs: 60_000 } } as never,
          {} as never,
        ),
    ],
  ])('%s: reconciles at startup and on an interval; shutdown waits for the run and stops it', async (_, make) => {
    vi.useFakeTimers();
    let finish!: () => void;
    const reconcile = vi.fn(() => new Promise<number>((r) => (finish = () => r(0))));
    const processor = make(reconcile);
    processor.onApplicationBootstrap();
    expect(reconcile).toHaveBeenCalledTimes(1);

    let closed = false;
    const shutdown = processor.onModuleDestroy().then(() => (closed = true));
    await Promise.resolve();
    expect(closed).toBe(false); // still waiting for the in-flight run
    finish();
    await shutdown;
    vi.advanceTimersByTime(10 * 60_000);
    expect(reconcile).toHaveBeenCalledTimes(1); // no run after teardown
  });
});
