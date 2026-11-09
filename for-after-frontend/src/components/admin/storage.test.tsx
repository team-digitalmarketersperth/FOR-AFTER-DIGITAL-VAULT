import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SourceTotals, StorageAsset, StoragePage } from '@/lib/api/admin';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { StorageDetail, StorageList } from './storage';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/storage' }));

const REF = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
const OWNER = '11111111-1111-4111-8111-111111111111';
const T = '2026-10-30T02:00:00.000Z';
const asset = (over: Partial<StorageAsset> = {}): StorageAsset => ({
  reference: REF,
  source: 'MEMORY_VAULT',
  kind: 'PHOTO',
  accountId: OWNER,
  sizeBytes: 3 * 1024 * 1024,
  sizeVerified: true,
  uploadState: 'ready',
  deletion: 'active',
  legacyStorage: false,
  createdAt: T,
  updatedAt: T,
  verifiedAt: T,
  deletedAt: null,
  storageDeletedAt: null,
  ...over,
});
const zero: SourceTotals = { pending: 0, ready: 0, failed: 0, verifiedBytes: 0, reservedBytes: 0, deletionPending: 0, deletionConfirmed: 0, total: 0 };
const summary = {
  MESSAGE: { ...zero, ready: 2, verifiedBytes: 1024 * 1024, pending: 1, reservedBytes: 512 * 1024, failed: 1, deletionPending: 1, total: 4 },
  MEMORY_VAULT: { ...zero, ready: 1, verifiedBytes: 3 * 1024 * 1024, total: 1 },
  MY_STORY: zero,
  MY_WISHES: zero,
  RECIPIENT_PHOTO: zero,
  // Outside customer quotas: never in the customer totals.
  DEATH_EVIDENCE: { ...zero, ready: 1, verifiedBytes: 100 * 1024 * 1024, total: 1 },
};
const page = (items: StorageAsset[], over: Partial<StoragePage> = {}): StoragePage => ({
  evaluatedAt: T,
  summary,
  items,
  pagination: { page: 1, limit: 25, total: items.length, pages: 1 },
  ...over,
});

describe('Storage & scans', () => {
  it('customer totals use quota definitions; evidence apart; units and confidence labelled; read-only', async () => {
    routeFetch({
      'GET /admin/storage/assets': json(200, page([asset(), asset({ reference: OWNER, uploadState: 'pending', sizeVerified: false, verifiedAt: null })])),
    });
    renderWithClient(<StorageList filters={{ page: 1 }} />);
    const totals = (await screen.findByRole('heading', { name: /Customer content/ })).closest('section')!;
    // 1 MB + 3 MB verified; 512 KB declared; evidence's 100 MB is not added.
    expect(within(totals).getAllByText('4.0 MB')[0]!.nextSibling).toHaveTextContent('Verified recorded storage');
    expect(within(totals).getAllByText('512 KB')[0]!.nextSibling).toHaveTextContent(/Reserved by uploads in progress \(declared\)/);
    expect(within(totals).getByRole('link', { name: /1\s*Failed verification/ })).toHaveAttribute('href', '/admin/storage?uploadState=failed');
    expect(within(totals).getByRole('link', { name: /1\s*Removal pending/ })).toHaveAttribute('href', '/admin/storage?deletion=pending');
    expect(within(totals).getByText('Outside customer quotas')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Stored-file records' });
    expect(within(table).getByText('Verified')).toBeInTheDocument();
    expect(within(table).getByText('Awaiting upload or checks')).toBeInTheDocument();
    expect(within(table).getByText('Declared, not verified')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Monitoring coverage' })).toHaveTextContent(
      /1 KB = 1,024 bytes.*not a storage bill.*Not recorded per file.*There is no quarantine/,
    );
    // No provider claims, no scan claims, no mutation or file controls.
    expect(document.body.textContent).not.toMatch(/scan passed|safe file|malware detected|provider storage used|stuck|orphan/i);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Apply filters', 'Refresh']);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href')).toMatch(/^\/admin\//);
  });

  it('totals that could not be read are "unavailable", never zero; the list still shows', async () => {
    routeFetch({ 'GET /admin/storage/assets': json(200, page([asset()], { summary: null })) });
    renderWithClient(<StorageList filters={{ page: 1 }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Totals are unavailable right now');
    expect(screen.queryByText('Verified recorded storage')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Stored-file records' })).toBeInTheDocument();
  });

  it('loading, then a failed refresh keeps the last result marked stale', async () => {
    let n = 0;
    routeFetch({ 'GET /admin/storage/assets': () => (n++ === 0 ? json(200, page([asset()])) : json(503, { message: 'x' })) });
    renderWithClient(<StorageList filters={{ page: 1 }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Loading stored-file records/);
    await screen.findByRole('table', { name: 'Stored-file records' });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t refresh.*may be out of date/);
    expect(screen.getByRole('table', { name: 'Stored-file records' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });

  it('empty and filtered-empty states', async () => {
    routeFetch({ 'GET /admin/storage/assets': json(200, page([])) });
    const { unmount } = renderWithClient(<StorageList filters={{ page: 1 }} />);
    expect(await screen.findByText('No stored-file records yet')).toBeInTheDocument();
    unmount();
    renderWithClient(<StorageList filters={{ page: 1, uploadState: 'failed' }} />);
    expect(await screen.findByText('No records match these filters')).toBeInTheDocument();
  });

  it('filters: validated before the URL; applied through the URL', async () => {
    routeFetch({ 'GET /admin/storage/assets': json(200, page([asset()])) });
    renderWithClient(<StorageList filters={{ page: 1 }} />);
    await screen.findByRole('table', { name: 'Stored-file records' });
    router.replace.mockClear();
    await userEvent.type(screen.getByLabelText('Account ID'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('Enter a full account ID.')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Account ID'));
    await userEvent.selectOptions(screen.getByLabelText('Removal'), 'pending');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(router.replace).toHaveBeenCalledWith(expect.stringMatching(/deletion=pending/), expect.anything());
  });

  it('detail: exact bytes and confidence, recorded times only, scan result not recorded, no file access', async () => {
    routeFetch({
      [`GET /admin/storage/assets/${REF}`]: json(
        200,
        asset({ uploadState: 'failed', sizeVerified: false, verifiedAt: null, deletion: 'pending', sizeBytes: 2048 }),
      ),
    });
    renderWithClient(<StorageDetail reference={REF} />);
    expect(await screen.findByRole('heading', { name: 'Memory Vault · photo' })).toBeInTheDocument();
    expect(screen.getByText('2 KB (2,048 bytes, declared, not verified)')).toBeInTheDocument();
    expect(screen.getByText('Failed verification')).toBeInTheDocument();
    expect(screen.getByText(/a type mismatch or a detected threat\. Which one is not recorded/)).toBeInTheDocument();
    expect(screen.getByText('Not recorded per file')).toBeInTheDocument();
    expect(screen.getAllByText('Not recorded').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/download|preview|rescan|signed url/i);
  });

  it('detail: evidence shows no account', async () => {
    routeFetch({ [`GET /admin/storage/assets/${REF}`]: json(200, asset({ source: 'DEATH_EVIDENCE', kind: null, accountId: null })) });
    renderWithClient(<StorageDetail reference={REF} />);
    expect(await screen.findByText('Not shown for evidence')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /stored-file records for this account/ })).not.toBeInTheDocument();
  });
});
