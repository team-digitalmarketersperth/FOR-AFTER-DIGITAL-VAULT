import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MediaManager } from '@/components/media/media-manager';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { StorageUsageSection } from './storage-usage';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/settings' }));

const GIB = 1024 ** 3;
const usage = (percentage: number, level: string, over: object = {}) => ({
  usedBytes: Math.round((5 * GIB * percentage) / 100),
  reservedBytes: 0,
  limitBytes: 5 * GIB,
  remainingBytes: Math.round((5 * GIB * (100 - percentage)) / 100),
  percentage,
  level,
  ...over,
});

describe('Storage usage (Phase 12C)', () => {
  it('normal: used of limit and a progress bar, no warning', async () => {
    routeFetch({ 'GET /users/me/storage': json(200, usage(76, 'NORMAL')) });
    renderWithClient(<StorageUsageSection />);
    expect(await screen.findByText(/of 5\.0 GB used/)).toHaveTextContent('3.8 GB of 5.0 GB used');
    expect(screen.getByRole('progressbar', { name: 'Storage used' })).toHaveAttribute('aria-valuenow', '76');
    expect(screen.queryByText(/storage is|most of your storage/)).not.toBeInTheDocument();
  });

  it('counts uploads in progress as used', async () => {
    routeFetch({
      'GET /users/me/storage': json(200, usage(0, 'NORMAL', { usedBytes: GIB, reservedBytes: GIB, percentage: 40 })),
    });
    renderWithClient(<StorageUsageSection />);
    expect(await screen.findByText(/of 5\.0 GB used/)).toHaveTextContent('2.0 GB of 5.0 GB used');
  });

  it.each([
    ['WARNING', 80, 'You’ve used most of your storage.'],
    ['HIGH', 90, 'Your storage is almost full.'],
    ['FULL', 100, 'Everything you’ve saved stays available'],
  ])('%s at %i %%: a calm notice, never an upgrade offer', async (level, pct, text) => {
    routeFetch({ 'GET /users/me/storage': json(200, usage(pct, level)) });
    renderWithClient(<StorageUsageSection />);
    expect(await screen.findByText(new RegExp(text))).toHaveAttribute('role', 'status');
    expect(screen.queryByText(/upgrade|plan|buy/i)).not.toBeInTheDocument();
  });

  it('an API error is shown instead of a wrong meter', async () => {
    routeFetch({ 'GET /users/me/storage': json(500, { message: 'Internal server error' }) });
    renderWithClient(<StorageUsageSection />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('an upload refused for storage shows the server’s message; existing files stay listed', async () => {
    const api = routeFetch({
      'GET /memory-vault/v1/media': json(200, [
        {
          id: 'a1',
          kind: 'PHOTO',
          status: 'READY',
          originalFileName: 'kept.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 100,
          uploadedAt: null,
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-01T00:00:00Z',
        },
      ]),
      'GET /memory-vault/v1/media/a1/access-url': json(200, { url: 'https://media.test/kept', expiresAt: '2030-01-01T00:00:00Z' }),
      'POST /memory-vault/v1/media/upload-url': json(409, {
        message: 'Your storage is full. Delete files you no longer need to add new ones.',
      }),
    });
    renderWithClient(<MediaManager scope={{ kind: 'memory-vault', id: 'v1' }} kinds={['PHOTO', 'AUDIO']} editable />);
    expect(await screen.findByRole('img', { name: 'kept.jpg' })).toBeInTheDocument();
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('input[type=file]')!,
      new File([new Uint8Array(4)], 'new.jpg', { type: 'image/jpeg' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Your storage is full.');
    // Nothing was sent to the provider; the existing file is still there.
    expect(api.calls.some((c) => c.path.includes('/complete'))).toBe(false);
    expect(screen.getByRole('img', { name: 'kept.jpg' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
