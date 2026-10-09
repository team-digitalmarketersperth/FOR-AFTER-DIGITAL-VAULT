import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fakeStorage, json, page, renderWithClient, routeFetch, router } from '@/test/utils';
import { EditRecipient, NewRecipient, RecipientDetail, RecipientList } from './recipients';
import { EditTrustedContact, NewTrustedContact, TrustedContactList } from './trusted-contacts';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/people' }));

const sofia = {
  id: 'r1',
  firstName: 'Sofia',
  lastName: 'Rossi',
  relationship: 'Daughter',
  email: 'sofia@example.com',
  mobile: null,
  birthday: '2010-01-01',
  privateNote: 'Loves the sea.',
  photoId: null as string | null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
const david = {
  ...sofia,
  id: 't1',
  firstName: 'David',
  lastName: 'Smith',
  relationship: 'Brother',
  invitation: { status: 'PENDING', sentAt: '2026-10-01T00:00:00Z' },
};
const sarah = { ...david, id: 't2', firstName: 'Sarah', lastName: 'Lee', invitation: { status: 'ACCEPTED', sentAt: '2026-10-01T00:00:00Z' } };

describe('People I Love', () => {
  it('lists people with relationship, birthday (date-only) and contact cues', async () => {
    routeFetch({ 'GET /recipients': json(200, page([sofia])) });
    renderWithClient(<RecipientList />);
    const card = await screen.findByRole('link', { name: /Sofia Rossi/ });
    expect(card).toHaveAttribute('href', '/people/r1');
    expect(card).toHaveTextContent('Daughter');
    expect(card).toHaveTextContent('Birthday 1 January 2010');
    expect(card).toHaveTextContent('Email');
  });

  it('shows a warm empty state', async () => {
    routeFetch({ 'GET /recipients': json(200, page([])) });
    renderWithClient(<RecipientList />);
    expect(await screen.findByText('No one added yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add someone you love/ })).toHaveAttribute('href', '/people/new');
  });

  it('validates before calling the API', async () => {
    const api = routeFetch({});
    renderWithClient(<NewRecipient />);
    await userEvent.type(screen.getByLabelText(/^Email/), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('Enter first name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('creates with only DTO fields, blanks as null and the birthday as typed', async () => {
    const api = routeFetch({ 'POST /recipients': json(201, sofia) });
    renderWithClient(<NewRecipient />);
    await userEvent.type(screen.getByLabelText('First name'), ' Sofia ');
    await userEvent.type(screen.getByLabelText(/^Birthday/), '2010-01-01');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/people/r1'));
    expect(api.called('POST', '/recipients')[0]).toMatchObject({
      credentials: 'include',
      body: {
        firstName: 'Sofia',
        lastName: null,
        relationship: null,
        email: null,
        mobile: null,
        birthday: '2010-01-01',
        privateNote: null,
      },
    });
  });

  it('edits with PATCH and can clear a field', async () => {
    const api = routeFetch({
      'GET /recipients/r1': json(200, sofia),
      'PATCH /recipients/r1': json(200, { ...sofia, relationship: null }),
    });
    renderWithClient(<EditRecipient id="r1" />);
    await userEvent.clear(await screen.findByLabelText(/^Relationship/));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/people/r1'));
    expect(api.called('PATCH', '/recipients/r1')[0].body).toMatchObject({ relationship: null, firstName: 'Sofia' });
  });

  it('removes only after confirming', async () => {
    const api = routeFetch({ 'GET /recipients/r1': json(200, sofia), 'DELETE /recipients/r1': new Response(null, { status: 204 }) });
    renderWithClient(<RecipientDetail id="r1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this person?' });
    expect(api.called('DELETE', '/recipients/r1')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/people'));
    expect(api.called('DELETE', '/recipients/r1')).toHaveLength(1);
  });

  it('shows the safe API error and a not-found state', async () => {
    routeFetch({
      'POST /recipients': json(400, { statusCode: 400, message: ['mobile must be a phone number, e.g. +61400000000'] }),
    });
    const { unmount } = renderWithClient(<NewRecipient />);
    await userEvent.type(screen.getByLabelText('First name'), 'Sofia');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('mobile must be a phone number, e.g. +61400000000')).toBeInTheDocument();
    unmount();

    routeFetch({ 'GET /recipients/zzz': json(404, { statusCode: 404, message: 'Recipient not found.' }) });
    renderWithClient(<RecipientDetail id="zzz" />);
    // Detail page without data: the not-found state is the page, so it is the h1.
    expect(await screen.findByRole('heading', { level: 1, name: 'We couldn’t find this person' })).toBeInTheDocument();
  });
});

describe('People I Love: pages (Phase 09)', () => {
  const many = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...sofia, id: `r${from + i}`, firstName: `Person ${from + i}`, lastName: null }));

  it('shows 25 at a time with an understated Previous / Next', async () => {
    const api = routeFetch({
      'GET /recipients': (_body: unknown, url: URL) =>
        url.searchParams.get('page') === '2'
          ? json(200, page(many(26, 2), { page: 2, total: 27, pages: 2 }))
          : json(200, page(many(1, 25), { total: 27, pages: 2 })),
    });
    renderWithClient(<RecipientList />);
    expect(await screen.findByText('Person 1')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2 · 27 people')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Person 27')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 2 · 27 people')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(api.called('GET', '/recipients')).toHaveLength(2);
  });

  it('no pager for a single page', async () => {
    routeFetch({ 'GET /recipients': json(200, page([sofia])) });
    renderWithClient(<RecipientList />);
    expect(await screen.findByText('Sofia Rossi')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'People I Love pages' })).not.toBeInTheDocument();
  });

  it('a page emptied by a removal steps back to the last real page', async () => {
    let total = 26;
    routeFetch({
      'GET /recipients': (_body: unknown, url: URL) => {
        const pages = Math.ceil(total / 25);
        if (url.searchParams.get('page') === '2') {
          return json(200, page(total > 25 ? many(26, 1) : [], { page: 2, total, pages }));
        }
        return json(200, page(many(1, 25), { total, pages }));
      },
    });
    const { queryClient } = renderWithClient(<RecipientList />);
    await screen.findByText('Person 1');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Person 26');
    total = 25; // the 26th was removed
    await queryClient.invalidateQueries();
    expect(await screen.findByText('Person 1')).toBeInTheDocument();
    expect(screen.queryByText('Person 26')).not.toBeInTheDocument();
  });
});

describe('People I Love: photo (Phase 09)', () => {
  const withPhoto = { ...sofia, photoId: 'p1' };
  const png = (size = 10) => new File([new Uint8Array(size)], 'mum.png', { type: 'image/png' });
  const pick = (file: File) =>
    userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, file, { applyAccept: false });
  const signed = (url: string) => json(200, { url, expiresAt: '2030-01-01T00:00:00Z' });
  const uploadTarget = (id: string) =>
    json(201, {
      mediaAssetId: id,
      upload: { url: 'https://upload.test/files', fields: { token: 't' } },
      expiresAt: '2030-01-01T00:00:00Z',
    });

  it('no photo: initials, no image and no URL requested', async () => {
    const api = routeFetch({ 'GET /recipients': json(200, page([sofia])) });
    renderWithClient(<RecipientList />);
    expect(await screen.findByText('SR')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(api.calls.some((c) => c.path.includes('/photo'))).toBe(false);
  });

  it('a photo is shown from a short-lived signed URL, initials underneath', async () => {
    routeFetch({
      'GET /recipients': json(200, page([withPhoto])),
      'GET /recipients/r1/photo/p1/access-url': signed('https://storage.test/p1'),
    });
    renderWithClient(<RecipientList />);
    await waitFor(() => expect(document.querySelector('img')).toHaveAttribute('src', 'https://storage.test/p1'));
    expect(screen.getByText('SR')).toBeInTheDocument();
  });

  it('upload: direct upload to the provider, verify with its file id, then the photo is current', async () => {
    const puts = fakeStorage(200);
    let current: string | null = null;
    const api = routeFetch({
      'GET /recipients/r1': () => json(200, { ...sofia, photoId: current }),
      'POST /recipients/r1/photo/upload-url': uploadTarget('p2'),
      'POST /recipients/r1/photo/p2/complete': () => {
        current = 'p2';
        return json(200, { id: 'p2', status: 'READY' });
      },
      'GET /recipients/r1/photo/p2/access-url': signed('https://storage.test/p2'),
    });
    renderWithClient(<RecipientDetail id="r1" />);
    await screen.findByRole('button', { name: 'Add a photo' });
    await pick(png());
    await waitFor(() => expect(document.querySelector('img')).toHaveAttribute('src', 'https://storage.test/p2'));
    expect(puts).toEqual([expect.objectContaining({ method: 'POST', url: 'https://upload.test/files' })]);
    expect(api.called('POST', '/recipients/r1/photo/p2/complete')[0].body).toEqual({ providerFileId: 'provider-file-1' });
    expect(api.called('POST', '/recipients/r1/photo/upload-url')[0].body).toEqual({
      kind: 'PHOTO',
      originalFileName: 'mum.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    });
    expect(await screen.findByRole('button', { name: 'Change photo' })).toBeInTheDocument();
  });

  it('refuses SVG and files over 5 MB before asking the API', async () => {
    const api = routeFetch({ 'GET /recipients/r1': json(200, sofia) });
    renderWithClient(<RecipientDetail id="r1" />);
    await screen.findByRole('button', { name: 'Add a photo' });
    await pick(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }));
    expect(await screen.findByText('Please choose a JPEG, PNG or WebP photo.')).toBeInTheDocument();
    await pick(png(5 * 1024 * 1024 + 1));
    expect(await screen.findByText('This file is larger than 5 MB.')).toBeInTheDocument();
    expect(api.called('POST', '/recipients/r1/photo/upload-url')).toHaveLength(0);
  });

  it('a failed upload can be retried', async () => {
    fakeStorage(0);
    const api = routeFetch({
      'GET /recipients/r1': json(200, sofia),
      'POST /recipients/r1/photo/upload-url': uploadTarget('p3'),
    });
    renderWithClient(<RecipientDetail id="r1" />);
    await screen.findByRole('button', { name: 'Add a photo' });
    await pick(png());
    expect(await screen.findByText(/couldn't upload this file/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.called('POST', '/recipients/r1/photo/upload-url')).toHaveLength(2));
  });

  it('remove: back to initials', async () => {
    let current: string | null = 'p1';
    const api = routeFetch({
      'GET /recipients/r1': () => json(200, { ...sofia, photoId: current }),
      'GET /recipients/r1/photo/p1/access-url': signed('https://storage.test/p1'),
      'DELETE /recipients/r1/photo/p1': () => {
        current = null;
        return new Response(null, { status: 204 });
      },
    });
    renderWithClient(<RecipientDetail id="r1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove photo' }));
    expect(await screen.findByRole('button', { name: 'Add a photo' })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(api.called('DELETE', '/recipients/r1/photo/p1')).toHaveLength(1);
  });
});

describe('Trusted Contacts', () => {
  const fill = async (fields: Record<string, string>) => {
    for (const [label, value] of Object.entries(fields)) {
      await userEvent.type(screen.getByLabelText(new RegExp(`^${label}`)), value);
    }
    await userEvent.click(screen.getByRole('button', { name: 'Add trusted contact' }));
  };

  it('explains the role without implying access to private content', async () => {
    routeFetch({ 'GET /trusted-contacts': json(200, [david]) });
    renderWithClient(<TrustedContactList />);
    expect(await screen.findByRole('link', { name: /David Smith/ })).toHaveAttribute('href', '/trusted-contacts/t1/edit');
    expect(screen.getByText(/does not give them access to your messages, memories or wishes/)).toBeInTheDocument();
    expect(screen.getByText(/our team verifies every report/)).toBeInTheDocument();
  });

  it('requires an email or a mobile', async () => {
    const api = routeFetch({ 'GET /trusted-contacts': json(200, []) });
    renderWithClient(<NewTrustedContact />);
    await fill({ 'First name': 'David' });
    expect(await screen.findByText('Provide an email or a mobile (or both).')).toBeInTheDocument();
    expect(api.called('POST', '/trusted-contacts')).toHaveLength(0);
  });

  it('shows the invitation state on each card', async () => {
    routeFetch({ 'GET /trusted-contacts': json(200, [david]) });
    renderWithClient(<TrustedContactList />);
    expect(await screen.findByRole('link', { name: /David Smith/ })).toHaveTextContent('Invitation pending');
    // One contact: adding another is still offered.
    expect(screen.getByRole('link', { name: 'Add a trusted contact' })).toBeInTheDocument();
  });

  it('at two contacts the add action is gone and the limit is explained', async () => {
    routeFetch({ 'GET /trusted-contacts': json(200, [david, sarah]) });
    renderWithClient(<TrustedContactList />);
    expect(await screen.findByRole('link', { name: /Sarah Lee/ })).toHaveTextContent('Invitation accepted');
    expect(screen.queryByRole('link', { name: 'Add a trusted contact' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('You can nominate up to 2 trusted contacts.');
  });

  it('the add page at the limit explains instead of showing a form', async () => {
    const api = routeFetch({ 'GET /trusted-contacts': json(200, [david, sarah]) });
    renderWithClient(<NewTrustedContact />);
    expect(await screen.findByRole('heading', { name: 'You’ve reached the limit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add trusted contact' })).not.toBeInTheDocument();
    expect(api.called('POST', '/trusted-contacts')).toHaveLength(0);
  });

  it('a 409 from the API (limit reached elsewhere) is shown on the form', async () => {
    routeFetch({
      'GET /trusted-contacts': json(200, [david]),
      'POST /trusted-contacts': json(409, {
        statusCode: 409,
        message: 'You can nominate up to 2 trusted contacts. Remove one to add someone else.',
      }),
    });
    renderWithClient(<NewTrustedContact />);
    await screen.findByLabelText(/^First name/);
    await fill({ 'First name': 'Zoe', Email: 'zoe@example.com' });
    expect(await screen.findByRole('alert')).toHaveTextContent('You can nominate up to 2 trusted contacts.');
  });

  it.each([
    ['PENDING', 'Resend invitation'],
    ['DECLINED', 'Resend invitation'],
    ['EXPIRED', 'Resend invitation'],
    ['NOT_SENT', 'Send invitation'],
  ])('%s: offers "%s", which posts to the invitation route', async (status, label) => {
    const contact = { ...david, invitation: { status, sentAt: status === 'NOT_SENT' ? null : '2026-10-01T00:00:00Z' } };
    const api = routeFetch({
      'GET /trusted-contacts/t1': json(200, contact),
      'POST /trusted-contacts/t1/invitation': json(200, { ...david, invitation: { status: 'PENDING', sentAt: '2026-10-06T00:00:00Z' } }),
    });
    renderWithClient(<EditTrustedContact id="t1" />);
    await userEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(api.called('POST', '/trusted-contacts/t1/invitation')).toHaveLength(1));
    expect(await screen.findByText('Invitation pending')).toBeInTheDocument();
  });

  it('ACCEPTED offers no resend; mobile-only explains that SMS invitations are not available', async () => {
    routeFetch({ 'GET /trusted-contacts/t1': json(200, { ...david, invitation: { status: 'ACCEPTED', sentAt: '2026-10-01T00:00:00Z' } }) });
    const { unmount } = renderWithClient(<EditTrustedContact id="t1" />);
    expect(await screen.findByText('They’ve accepted the invitation.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invitation/ })).not.toBeInTheDocument();
    unmount();

    routeFetch({
      'GET /trusted-contacts/t1': json(200, { ...david, email: null, mobile: '+61400000000', invitation: { status: 'UNAVAILABLE', sentAt: null } }),
    });
    renderWithClient(<EditTrustedContact id="t1" />);
    expect(await screen.findByText(/Text-message invitations aren’t available yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invitation/ })).not.toBeInTheDocument();
  });

  it.each([
    ['email only', { Email: 'david@example.com' }, { email: 'david@example.com', mobile: null }],
    ['mobile only', { Mobile: '+61 400 000 000' }, { email: null, mobile: '+61 400 000 000' }],
  ])('accepts %s', async (_name, fields, expected) => {
    const api = routeFetch({ 'GET /trusted-contacts': json(200, []), 'POST /trusted-contacts': json(201, david) });
    renderWithClient(<NewTrustedContact />);
    await screen.findByLabelText(/^First name/);
    await fill({ 'First name': 'David', ...fields });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/trusted-contacts'));
    expect(api.called('POST', '/trusted-contacts')[0].body).toMatchObject({ firstName: 'David', ...expected });
  });

  it('edits, removes after confirming, and shows API errors', async () => {
    const api = routeFetch({
      'GET /trusted-contacts/t1': json(200, david),
      'PATCH /trusted-contacts/t1': json(400, { statusCode: 400, message: 'Provide an email or a mobile (or both).' }),
      'DELETE /trusted-contacts/t1': new Response(null, { status: 204 }),
    });
    renderWithClient(<EditTrustedContact id="t1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Provide an email or a mobile (or both).');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/trusted-contacts'));
    expect(api.called('DELETE', '/trusted-contacts/t1')).toHaveLength(1);
  });
});
