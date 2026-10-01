import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
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
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
const david = { ...sofia, id: 't1', firstName: 'David', lastName: 'Smith', relationship: 'Brother' };

describe('People I Love', () => {
  it('lists people with relationship, birthday (date-only) and contact cues', async () => {
    routeFetch({ 'GET /recipients': json(200, [sofia]) });
    renderWithClient(<RecipientList />);
    const card = await screen.findByRole('link', { name: /Sofia Rossi/ });
    expect(card).toHaveAttribute('href', '/people/r1');
    expect(card).toHaveTextContent('Daughter');
    expect(card).toHaveTextContent('Birthday 1 January 2010');
    expect(card).toHaveTextContent('Email');
  });

  it('shows a warm empty state', async () => {
    routeFetch({ 'GET /recipients': json(200, []) });
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
    expect(await screen.findByText('We couldn’t find this person')).toBeInTheDocument();
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
    const api = routeFetch({});
    renderWithClient(<NewTrustedContact />);
    await fill({ 'First name': 'David' });
    expect(await screen.findByText('Provide an email or a mobile (or both).')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it.each([
    ['email only', { Email: 'david@example.com' }, { email: 'david@example.com', mobile: null }],
    ['mobile only', { Mobile: '+61 400 000 000' }, { email: null, mobile: '+61 400 000 000' }],
  ])('accepts %s', async (_name, fields, expected) => {
    const api = routeFetch({ 'POST /trusted-contacts': json(201, david) });
    renderWithClient(<NewTrustedContact />);
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
