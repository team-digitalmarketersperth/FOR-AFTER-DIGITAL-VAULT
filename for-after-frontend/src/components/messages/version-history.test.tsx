import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Message, MessageVersionSummary } from '@/lib/api/messages';
import { json, page, renderWithClient, routeFetch, router } from '@/test/utils';
import { MessageDetail } from './message-detail';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/messages/m1' }));

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  title: 'Version B title',
  contentType: 'TEXT',
  textContent: 'Version B words.',
  privateNote: null,
  status: 'DRAFT',
  createdAt: '2026-08-15T00:00:00Z',
  updatedAt: '2026-10-12T00:00:00Z',
  recipients: [{ id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter' }],
  version: 2,
  ...over,
});
const v = (version: number, reason: MessageVersionSummary['reason'], isCurrent = false): MessageVersionSummary => ({
  id: `v${version}`,
  version,
  reason,
  createdAt: `2026-10-${10 + version}T01:08:00Z`,
  isCurrent,
});
const v1Detail = { ...v(1, 'CREATED'), title: 'Version A title', contentType: 'TEXT', textContent: 'Version A words.' };
const schedule = {
  id: 's1',
  triggerType: 'FIXED_DATE',
  scheduledFor: '2030-12-25T01:00:00.000Z',
  afterDeathDays: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const routes = (m: Message, versions: () => MessageVersionSummary[]) => ({
  'GET /messages/m1': json(200, m),
  'GET /messages/m1/media': json(200, []),
  'GET /messages/m1/schedule': m.status === 'DRAFT' ? json(404, {}) : json(200, schedule),
  'GET /messages/m1/versions': () => json(200, page(versions())),
  'GET /messages/m1/versions/v1': json(200, v1Detail),
});

const openHistory = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Version history' }));
  return screen.findByRole('list', { name: 'Saved versions' });
};

describe('Version history', () => {
  it('lists versions newest first with Created / Edited labels and marks the current one', async () => {
    routeFetch(routes(message(), () => [v(2, 'EDITED', true), v(1, 'CREATED')]));
    renderWithClient(<MessageDetail id="m1" />);
    const list = await openHistory();
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Version 2');
    expect(rows[0]).toHaveTextContent('Current');
    expect(rows[0]).toHaveTextContent(/Edited · 12 Oct 2026/);
    expect(rows[1]).toHaveTextContent(/Created · 11 Oct 2026/);
    expect(rows[1]).not.toHaveTextContent('Current');
  });

  it('previews a version, restores it after confirming, and the replaced draft stays in history', async () => {
    let versions = [v(2, 'EDITED', true), v(1, 'CREATED')];
    const api = routeFetch({
      ...routes(message(), () => versions),
      'POST /messages/m1/versions/v1/restore': () => {
        versions = [v(3, 'RESTORED', true), v(2, 'EDITED'), v(1, 'CREATED')];
        return json(200, message({ title: 'Version A title', textContent: 'Version A words.', version: 3 }));
      },
    });
    renderWithClient(<MessageDetail id="m1" />);
    const list = await openHistory();
    await userEvent.click(within(list).getByRole('button', { name: /Version 1/ }));
    expect(await screen.findByRole('heading', { name: 'Version A title' })).toBeInTheDocument();
    expect(screen.getByText('Version A words.')).toBeInTheDocument();
    expect(screen.getByText('This restores the written content only.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore this version?' });
    expect(dialog).toHaveTextContent('Your current draft will be kept in version history');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore version' }));

    await waitFor(() => expect(api.called('POST', '/messages/m1/versions/v1/restore')).toHaveLength(1));
    const after = await screen.findByRole('list', { name: 'Saved versions' });
    await waitFor(() => expect(within(after).getAllByRole('listitem')).toHaveLength(3));
    expect(within(after).getAllByRole('listitem')[0]).toHaveTextContent(/Version 3.*Current.*Restored an earlier version/);
    expect(within(after).getAllByRole('listitem')[1]).toHaveTextContent('Version 2');
    // The page now shows the restored words.
    // (Behind the open sheet, so hidden from the accessibility tree.)
    expect(screen.getByRole('region', { name: 'Message', hidden: true })).toHaveTextContent('Version A words.');
  });

  it('SCHEDULED: history is readable, restore is disabled with the way to unschedule', async () => {
    const api = routeFetch(routes(message({ status: 'SCHEDULED' }), () => [v(2, 'EDITED', true), v(1, 'CREATED')]));
    renderWithClient(<MessageDetail id="m1" />);
    const list = await openHistory();
    await userEvent.click(within(list).getByRole('button', { name: /Version 1/ }));
    expect(await screen.findByRole('button', { name: 'Restore this version' })).toBeDisabled();
    expect(screen.getByText('This message is scheduled. Unschedule it before restoring an earlier version.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Unschedule to edit' })).toHaveAttribute('href', '/messages/m1?focus=schedule');
    expect(api.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('RELEASED: restore is disabled', async () => {
    const api = routeFetch(routes(message({ status: 'RELEASED' }), () => [v(2, 'EDITED', true), v(1, 'CREATED')]));
    renderWithClient(<MessageDetail id="m1" />);
    const list = await openHistory();
    await userEvent.click(within(list).getByRole('button', { name: /Version 1/ }));
    expect(await screen.findByRole('button', { name: 'Restore this version' })).toBeDisabled();
    expect(screen.getByText("Released messages can't be replaced.")).toBeInTheDocument();
    expect(api.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('a message from before version history explains that versions start with the next save', async () => {
    routeFetch(routes(message({ version: 0 }), () => []));
    renderWithClient(<MessageDetail id="m1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Version history' }));
    expect(await screen.findByText('No earlier versions yet')).toBeInTheDocument();
  });
});
