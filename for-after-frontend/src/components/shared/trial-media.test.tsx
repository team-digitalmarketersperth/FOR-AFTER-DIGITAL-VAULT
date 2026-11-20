import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MediaManager } from '@/components/media/media-manager';
import { CreateMessageFromMemory } from '@/components/memory-vault/memory-to-message';
import { EditMessage, NewMessage } from '@/components/messages/message-form';
import { fakeStorage, json, renderWithClient, routeFetch, router } from '@/test/utils';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/messages' }));

// Trial Step 4: photos, voice recordings and videos are paid-only during an enforced active trial (GET /billing
// features.media === false). Paid, exempt and billing-off accounts never see these locks.
const HEADING = 'Photos and recordings come with a plan';
const TEXT = 'Your free trial includes written messages. For After Premium adds photos and voice recordings; video is part of For After Complete.';
const billing = (media: boolean) =>
  json(200, {
    enabled: true,
    state: media ? 'paid_active' : 'trial_active',
    enforced: true,
    hasAccess: true,
    trialEligible: false,
    trial: null,
    subscription: null,
    plans: [],
    canManageSubscription: false,
    trialCaps: media ? { recipients: null, trustedContacts: null } : { recipients: 1, trustedContacts: 1 },
    features: { media },
  });
const TRIAL = billing(false);
const PAID = billing(true);
const scope = { kind: 'memory-vault', id: 'v1' } as const;
const file = (id: string, kind = 'PHOTO', status = 'READY') => ({
  id,
  kind,
  status,
  originalFileName: `${id}.jpg`,
  mimeType: 'image/jpeg',
  sizeBytes: 100,
  uploadedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const page = (items: unknown[]) => ({ items, pagination: { page: 1, limit: 100, total: items.length, pages: 1 } });
const sofia = { id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter', email: null, mobile: null, birthday: null, privateNote: null, photoId: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
const message = (over: object = {}) => ({
  id: 'm1',
  title: 'For Sofia',
  contentType: 'TEXT',
  textContent: 'Dear Sofia,',
  privateNote: null,
  status: 'DRAFT',
  version: 1,
  createdAt: '2026-09-02T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  recipients: [{ id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter' }],
  ...over,
});

const expectPaidDialog = async () => {
  const dialog = await screen.findByRole('dialog', { name: HEADING });
  expect(within(dialog).getByText(TEXT)).toBeInTheDocument();
  expect(within(dialog).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
  return dialog;
};

describe('Paid-only media controls (Trial Step 4)', () => {
  it('trial: media controls show Premium and open the explanation; existing files stay listed with Remove', async () => {
    const api = routeFetch({ 'GET /memory-vault/v1/media': json(200, [file('kept')]), 'GET /billing': TRIAL });
    renderWithClient(<MediaManager scope={scope} kinds={['PHOTO', 'AUDIO']} editable />);
    const add = await screen.findByRole('button', { name: /Add a photo\s*Premium/ });
    expect(screen.getByRole('button', { name: /Upload audio\s*Premium/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Record your voice\s*Premium/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove kept.jpg' })).toBeInTheDocument();
    // Keyboard: focus, Enter opens; Escape closes and focus returns.
    add.focus();
    await userEvent.keyboard('{Enter}');
    await expectPaidDialog();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(add).toHaveFocus();
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('paid or exempt: the normal controls, no tier badge', async () => {
    routeFetch({ 'GET /memory-vault/v1/media': json(200, []), 'GET /billing': PAID });
    renderWithClient(<MediaManager scope={scope} kinds={['PHOTO']} editable />);
    expect(await screen.findByRole('button', { name: 'Add a photo' })).toBeInTheDocument();
    expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
  });

  it('plan unreadable: a quiet status with its own retry (distinct from content retries); the API still decides', async () => {
    const api = routeFetch({ 'GET /memory-vault/v1/media': json(200, []), 'GET /billing': json(503, { message: 'down' }) });
    renderWithClient(<MediaManager scope={scope} kinds={['PHOTO']} editable />);
    expect(await screen.findByText('We couldn’t check your plan just now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a photo' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check plan again' }));
    await waitFor(() => expect(api.called('GET', '/billing').length).toBeGreaterThan(1));
  });

  it('a stale page whose upload is refused (PAID_FEATURE) says so with View plans, no pointless Try again', async () => {
    const puts = fakeStorage();
    routeFetch({
      'GET /memory-vault/v1/media': json(200, []),
      'GET /billing': PAID,
      'POST /memory-vault/v1/media/upload-url': json(409, { statusCode: 409, code: 'PAID_FEATURE', message: TEXT }),
    });
    const { container } = renderWithClient(<MediaManager scope={scope} kinds={['PHOTO']} editable />);
    await screen.findByRole('button', { name: 'Add a photo' });
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    await userEvent.upload(input, new File([new Uint8Array([0xff, 0xd8, 0xff])], 'p.jpg', { type: 'image/jpeg' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(TEXT);
    expect(within(alert).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(puts).toHaveLength(0);
  });
});

describe('Message formats (Trial Step 4)', () => {
  it('new message in a trial: Written is selectable; other formats show Premium, and the dialog keeps the typed text', async () => {
    const api = routeFetch({ 'GET /recipients': json(200, page([sofia])), 'GET /billing': TRIAL, 'POST /messages': json(201, message()) });
    renderWithClient(<NewMessage />);
    expect(await screen.findByRole('radio', { name: /Written/ })).toBeChecked();
    await waitFor(() => expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['TEXT']));
    await userEvent.type(screen.getByLabelText('Title'), 'For Sofia');
    await userEvent.type(screen.getByLabelText(/^Message/), 'Dear Sofia,');
    for (const name of [/Photos?\s*Premium/, /Voice|Audio/, /Video\s*Complete/, /Mixed\s*Premium/]) {
      expect(screen.getAllByRole('button', { name }).length).toBeGreaterThan(0);
    }
    await userEvent.click(screen.getByRole('button', { name: /Mixed\s*Premium/ }));
    const dialog = await expectPaidDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.getByLabelText('Title')).toHaveValue('For Sofia');
    expect(screen.getByLabelText(/^Message/)).toHaveValue('Dear Sofia,');
    expect(screen.getByRole('radio', { name: /Written/ })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: /Sofia/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.called('POST', '/messages')).toHaveLength(1));
    expect(api.called('POST', '/messages')[0].body).toMatchObject({ contentType: 'TEXT', textContent: 'Dear Sofia,' });
  });

  it('paid: every format is a normal choice', async () => {
    routeFetch({ 'GET /recipients': json(200, page([sofia])), 'GET /billing': PAID });
    renderWithClient(<NewMessage />);
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(5));
    expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
  });

  it('a photo message from before the trial keeps its own format selectable; only the others are marked by tier', async () => {
    routeFetch({ 'GET /messages/m1': json(200, message({ contentType: 'PHOTO', textContent: null })), 'GET /recipients': json(200, page([sofia])), 'GET /billing': TRIAL });
    renderWithClient(<EditMessage id="m1" />);
    await waitFor(() => expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['TEXT', 'PHOTO']));
    expect(screen.getByRole('radio', { name: /Photo/ })).toBeChecked();
  });

  it('a refused save (stale plan) keeps the form and offers View plans', async () => {
    routeFetch({
      'GET /recipients': json(200, page([sofia])),
      'GET /billing': PAID,
      'POST /messages': json(409, { statusCode: 409, code: 'PAID_FEATURE', message: TEXT }),
    });
    renderWithClient(<NewMessage />);
    await userEvent.click(await screen.findByRole('radio', { name: /Mixed/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Sofia/ }));
    await userEvent.type(screen.getByLabelText('Title'), 'Kept');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(TEXT)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(screen.getByLabelText('Title')).toHaveValue('Kept');
  });
});

describe('Content to message (Trial Step 4)', () => {
  const routes = (plan: Response) => ({
    'GET /memory-vault/v1': json(200, { id: 'v1', title: 'Christmas', category: 'FAMILY', textContent: 'Words', tags: [], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }),
    'GET /memory-vault/v1/media': json(200, [file('tree'), file('carols', 'AUDIO')]),
    'GET /recipients': json(200, page([sofia])),
    'GET /billing': plan,
  });

  it('trial: text is the type, files are replaced by one Premium control, and only text is sent', async () => {
    const api = routeFetch({ ...routes(TRIAL), 'POST /memory-vault/v1/messages': json(201, message()) });
    renderWithClient(<CreateMessageFromMemory id="v1" />);
    await userEvent.click(await screen.findByRole('button', { name: /Copy its photos and recordings \(2\)\s*Premium/ }));
    const dialog = await expectPaidDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('checkbox', { name: /tree\.jpg/ })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Written/ })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: /Sofia/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create draft message' }));
    await waitFor(() => expect(api.called('POST', '/memory-vault/v1/messages')).toHaveLength(1));
    expect(api.called('POST', '/memory-vault/v1/messages')[0].body).toMatchObject({ contentType: 'TEXT', mediaAssetIds: [] });
  });

  it('paid: files can be picked and the default stays Mixed', async () => {
    routeFetch(routes(PAID));
    renderWithClient(<CreateMessageFromMemory id="v1" />);
    expect(await screen.findByRole('checkbox', { name: /tree\.jpg/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Mixed/ })).toBeChecked();
    expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
  });
});
