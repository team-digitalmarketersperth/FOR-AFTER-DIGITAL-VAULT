import {
  buildReport,
  classify,
  formatReport,
  PAGE_SIZE,
  type FindRows,
  type ProviderFile,
} from './storage-reconciliation.js';

const file = (n: number, over: Partial<ProviderFile> = {}): ProviderFile => ({
  fileId: `f${n}`,
  filePath: `/for-after/users/u1/messages/m1/photo/a${n}.jpg`,
  size: 100,
  ...over,
});
const live = { status: 'READY', deletedAt: null, storageDeletedAt: null, providerFileId: null } as const;

describe('storage reconciliation report (read-only)', () => {
  it('classifies live, pending, cleanup candidates and unmatched files', () => {
    const at = new Date();
    expect(classify(file(1), live).category).toBe('live');
    expect(classify(file(1), { ...live, providerFileId: 'f1' }).category).toBe('live');
    expect(classify(file(2), { ...live, status: 'PENDING_UPLOAD' }).category).toBe('pending');
    expect(classify(file(3), { ...live, status: 'FAILED' })).toMatchObject({
      category: 'cleanup',
      reason: 'row deleted or failed; cleanup not finished',
    });
    // The case the settling fix prevents: a file back after cleanup was confirmed.
    expect(classify(file(4), { ...live, deletedAt: at, storageDeletedAt: at }).reason).toMatch(
      /present after cleanup was confirmed/,
    );
    expect(classify(file(5))).toMatchObject({ category: 'unmatched', reason: 'no media row has this path' });
    expect(classify(file(6), { ...live, providerFileId: 'other' }).category).toBe('unmatched');
  });

  it('pages through the whole library until a short page, skipping files outside the app folder', async () => {
    const all = Array.from({ length: PAGE_SIZE * 2 + 5 }, (_, i) =>
      i % 500 === 0 ? file(i, { filePath: `/marketing/banner-${i}.png` }) : file(i),
    );
    const listPage = vi.fn((skip: number, limit: number) => Promise.resolve(all.slice(skip, skip + limit)));
    const findRows: FindRows = vi.fn((paths: string[]) =>
      Promise.resolve(new Map(paths.filter((p) => !p.endsWith('/a7.jpg')).map((p) => [p, live]))),
    );
    const report = await buildReport(listPage, findRows);
    expect(listPage.mock.calls).toEqual([
      [0, PAGE_SIZE],
      [PAGE_SIZE, PAGE_SIZE],
      [PAGE_SIZE * 2, PAGE_SIZE],
    ]);
    expect(report.scanned).toBe(all.length);
    expect(report.outsideApp).toBe(5);
    expect(report.counts.unmatched.files).toBe(1);
    expect(report.counts.live.files).toBe(all.length - 5 - 1);
    expect(report.attention.map((f) => f.fileId)).toEqual(['f7']);
  });

  it('an exact multiple of the page size ends on the empty page that follows', async () => {
    const all = Array.from({ length: PAGE_SIZE }, (_, i) => file(i));
    const listPage = vi.fn((skip: number) => Promise.resolve(skip ? [] : all));
    const report = await buildReport(listPage, () => Promise.resolve(new Map()));
    expect(listPage).toHaveBeenCalledTimes(2);
    expect(report.counts.unmatched.files).toBe(PAGE_SIZE);
  });

  it('the printed report has ids, paths and sizes only: no URLs or signatures', async () => {
    const report = await buildReport(
      () => Promise.resolve([file(1), file(2)]),
      () => Promise.resolve(new Map([[file(1).filePath, { ...live, status: 'FAILED' as const }]])),
    );
    const text = formatReport(report);
    expect(text).toContain('read-only; nothing was changed');
    expect(text).toContain(`cleanup\tf1\t${file(1).filePath}\t100`);
    expect(text).toContain('unmatched\tf2');
    expect(text).not.toMatch(/https?:|ik-s=|ik-t=|token/i);
  });
});
