import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BILLING_OFF, fakeStorage, json, page, renderWithClient, routeFetch as baseRouteFetch, router } from '@/test/utils';

// Step 7: create pages open once the plan is known; screens that don't test the plan read billing off.
const routeFetch = (routes: Parameters<typeof baseRouteFetch>[0]) => baseRouteFetch({ 'GET /billing': json(200, BILLING_OFF), ...routes });
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
  invitation: { status: 'PENDING', sentAt: '2026-10-01T00:00:00Z', channel: 'EMAIL' },
  readiness: { status: 'INVITATION_PENDING', reason: null, invitationSentAt: '2026-10-01T00:00:00Z', invitationAcceptedAt: null },
};
const readyState = { status: 'READY', reason: null, invitationSentAt: '2026-10-01T00:00:00Z', invitationAcceptedAt: '2026-10-12T00:00:00Z' };
const sarah = {
  ...david,
  id: 't2',
  firstName: 'Sarah',
  lastName: 'Lee',
  invitation: { status: 'ACCEPTED', sentAt: '2026-10-01T00:00:00Z' },
  readiness: readyState,
};

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
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    await userEvent.type(screen.getByLabelText(/^Email/), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('Enter first name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    // Nothing is submitted (the page only reads the list and plan for the trial cap).
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('creates with only DTO fields, blanks as null and the birthday as typed', async () => {
    const api = routeFetch({ 'POST /recipients': json(201, sofia) });
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
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
    await userEvent.selectOptions(await screen.findByLabelText(/^Relationship/), 'Not set');
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

  it('a Recipient mobile is read for its country and sent as E.164 (SMS sign-in)', async () => {
    const api = routeFetch({ 'POST /recipients': json(201, { id: 'r9' }) });
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    await userEvent.type(screen.getByLabelText('First name'), 'Max');
    // jsdom's browser region is en-US: a visible, changeable default.
    expect(countryButton()).toHaveTextContent('United States (+1)');
    await userEvent.type(screen.getByLabelText(/^Mobile/), '0491 570 006');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('Check this number: it doesn’t look like a valid number for United States.')).toBeInTheDocument();
    expect(api.called('POST', '/recipients')).toHaveLength(0);
    await pickCountry('austral', 'Australia (+61)');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    await waitFor(() => expect(api.called('POST', '/recipients')).toHaveLength(1));
    // The domestic 0 is the trunk prefix, not concatenated after +61.
    expect(api.called('POST', '/recipients')[0].body).toMatchObject({ mobile: '+61491570006' });
  });

  it('shows the safe API error and a not-found state', async () => {
    routeFetch({
      'POST /recipients': json(400, { statusCode: 400, message: ['mobile must be a phone number, e.g. +61400000000'] }),
    });
    const { unmount } = renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
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

const countryButton = () => screen.getByRole('button', { name: /^Country for mobile/ });
/** Open the country picker, search, and pick with the keyboard (Enter). */
async function pickCountry(search: string, label: string) {
  await userEvent.click(countryButton());
  await userEvent.type(await screen.findByRole('combobox', { name: 'Search countries' }), search);
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(countryButton()).toHaveTextContent(label));
}
const languages = (tags: string[]) => vi.spyOn(navigator, 'languages', 'get').mockReturnValue(tags);
const savePerson = async (name: 'Add person' | 'Save changes') => userEvent.click(screen.getByRole('button', { name }));

describe('People I Love: mobile country', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults to the browser’s stated region; Australian domestic and international entries both give E.164', async () => {
    languages(['en-AU']);
    const api = routeFetch({ 'POST /recipients': json(201, { id: 'r9' }) });
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    expect(countryButton()).toHaveTextContent('Australia (+61)');
    await userEvent.type(screen.getByLabelText('First name'), 'Max');
    await userEvent.type(screen.getByLabelText(/^Mobile/), '+64 21 555 0123');
    await savePerson('Add person');
    await waitFor(() => expect(api.called('POST', '/recipients')).toHaveLength(1));
    // A typed +code wins over the chosen country.
    expect(api.called('POST', '/recipients')[0].body).toMatchObject({ mobile: '+64215550123' });
  });

  it('no stated region: no country is assumed; a domestic number asks for one, blank stays optional', async () => {
    languages(['en']);
    const api = routeFetch({ 'POST /recipients': json(201, { id: 'r9' }) });
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    expect(countryButton()).toHaveTextContent('Choose country');
    await userEvent.type(screen.getByLabelText('First name'), 'Max');
    await userEvent.type(screen.getByLabelText(/^Mobile/), '021 555 0123');
    await savePerson('Add person');
    expect(await screen.findByText('Choose the country for this number, or start it with + and the country code.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Mobile/)).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(screen.getByLabelText(/^Mobile/));
    await savePerson('Add person');
    await waitFor(() => expect(api.called('POST', '/recipients')).toHaveLength(1));
    expect(api.called('POST', '/recipients')[0].body).toMatchObject({ mobile: null });
  });

  it('countries sharing +1 are listed separately; searching "+1" finds both and Canada is kept', async () => {
    languages(['en-AU']);
    const api = routeFetch({ 'POST /recipients': json(201, { id: 'r9' }) });
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    await userEvent.click(countryButton());
    await userEvent.type(await screen.findByRole('combobox', { name: 'Search countries' }), '+1');
    const list = screen.getByRole('listbox', { name: 'Countries' });
    expect(within(list).getByRole('option', { name: /United States\s*\+1/ })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /Canada\s*\+1/ })).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('option', { name: /Canada/ }));
    expect(countryButton()).toHaveTextContent('Canada (+1)');
    await userEvent.type(screen.getByLabelText('First name'), 'Max');
    await userEvent.type(screen.getByLabelText(/^Mobile/), '613 555 0123');
    await savePerson('Add person');
    await waitFor(() => expect(api.called('POST', '/recipients')).toHaveLength(1));
    expect(api.called('POST', '/recipients')[0].body).toMatchObject({ mobile: '+16135550123' });
  });

  it('keyboard: Enter opens, arrows move, Escape closes and focus returns to the button', async () => {
    languages(['en-AU']);
    routeFetch({});
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    countryButton().focus();
    await userEvent.keyboard('{Enter}');
    const search = await screen.findByRole('combobox', { name: 'Search countries' });
    expect(search).toHaveFocus();
    // Opens on the current country; ArrowDown moves to the next one.
    expect(search).toHaveAttribute('aria-activedescendant', 'mobileCountry-option-AU');
    await userEvent.keyboard('{ArrowDown}');
    expect(search).toHaveAttribute('aria-activedescendant', 'mobileCountry-option-AT');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Search countries' })).not.toBeInTheDocument());
    expect(countryButton()).toHaveFocus();
    expect(countryButton()).toHaveTextContent('Australia (+61)');
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('zzzz');
    expect(await screen.findByText('No country matches “zzzz”.')).toBeInTheDocument();
  });

  it('edit: saved numbers open on their own country (US vs Canada on +1) and save unchanged', async () => {
    languages(['en-AU']);
    const api = routeFetch({
      'GET /recipients/r1': json(200, { ...sofia, mobile: '+16135550123' }),
      'PATCH /recipients/r1': json(200, sofia),
    });
    renderWithClient(<EditRecipient id="r1" />);
    expect(await screen.findByLabelText(/^Mobile/)).toHaveValue('(613) 555-0123');
    expect(countryButton()).toHaveTextContent('Canada (+1)');
    await savePerson('Save changes');
    await waitFor(() => expect(api.called('PATCH', '/recipients/r1')).toHaveLength(1));
    expect(api.called('PATCH', '/recipients/r1')[0].body).toMatchObject({ mobile: '+16135550123' });
  });

  it('edit: an unreadable saved number is kept as saved, flagged, and only re-checked once changed', async () => {
    languages(['en-AU']);
    const api = routeFetch({
      'GET /recipients/r1': json(200, { ...sofia, mobile: '+6140000' }),
      'PATCH /recipients/r1': json(200, sofia),
    });
    renderWithClient(<EditRecipient id="r1" />);
    const mobile = await screen.findByLabelText(/^Mobile/);
    expect(mobile).toHaveValue('+6140000');
    expect(screen.getByText(/couldn’t work out the country of this saved number/)).toBeInTheDocument();
    await userEvent.type(mobile, '1');
    await savePerson('Save changes');
    expect(await screen.findByText('Check this number: it doesn’t look like a valid phone number.')).toBeInTheDocument();
    expect(api.called('PATCH', '/recipients/r1')).toHaveLength(0);
    await userEvent.type(mobile, '{Backspace}');
    await userEvent.type(screen.getByLabelText(/^Last name/), 'x');
    await savePerson('Save changes');
    await waitFor(() => expect(api.called('PATCH', '/recipients/r1')).toHaveLength(1));
    expect(api.called('PATCH', '/recipients/r1')[0].body).toMatchObject({ mobile: '+6140000', lastName: 'Rossix' });
  });

  it('edit: changing only the country of a saved number is refused until the number is entered on purpose', async () => {
    languages(['en-AU']);
    const api = routeFetch({
      'GET /recipients/r1': json(200, { ...sofia, mobile: '+61412345678' }),
      'PATCH /recipients/r1': json(200, sofia),
    });
    renderWithClient(<EditRecipient id="r1" />);
    const mobile = await screen.findByLabelText(/^Mobile/);
    expect(mobile).toHaveValue('0412 345 678');
    // "0412 345 678" is also a valid German number: never saved as +49 without the person typing it.
    await pickCountry('Germany', 'Germany (+49)');
    await savePerson('Save changes');
    expect(await screen.findByText(/This number is saved as \+61 412 345 678\. With this country it would become \+49/)).toBeInTheDocument();
    expect(api.called('PATCH', '/recipients/r1')).toHaveLength(0);
    // Back to Australia: the saved value, exactly.
    await pickCountry('Australia', 'Australia (+61)');
    await savePerson('Save changes');
    await waitFor(() => expect(api.called('PATCH', '/recipients/r1')).toHaveLength(1));
    expect(api.called('PATCH', '/recipients/r1')[0].body).toMatchObject({ mobile: '+61412345678' });
  });

  it('server render is deterministic: the browser region is applied only after mount', async () => {
    languages(['en-AU']);
    routeFetch({});
    const { renderToString } = await import('react-dom/server');
    const { QueryClientProvider } = await import('@tanstack/react-query');
    const { makeQueryClient } = await import('@/lib/query/query-client');
    // The plan is already known (Step 7: the form waits for it).
    const client = makeQueryClient();
    client.setQueryData(['billing'], BILLING_OFF);
    const html = renderToString(
      <QueryClientProvider client={client}>
        <NewRecipient />
      </QueryClientProvider>,
    );
    expect(html).toContain('Choose country');
    expect(html).not.toContain('Australia (+61)');
    // In the browser, after mount: the stated region, as a changeable default.
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    expect(countryButton()).toHaveTextContent('Australia (+61)');
  });
});

describe('People I Love: relationship', () => {
  it('offers the choices with a hint; a choice is saved as its label', async () => {
    const api = routeFetch({ 'POST /recipients': json(201, { id: 'r9' }) });
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    const select = screen.getByLabelText(/^Relationship/);
    expect(select).toHaveAccessibleDescription('Their relationship to you.');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Not set', 'Partner', 'Parent', 'Child', 'Sibling', 'Grandparent', 'Grandchild', 'Friend', 'Relative', 'Other',
    ]);
    expect(screen.getByLabelText('Please specify the relationship')).not.toBeVisible();
    await userEvent.type(screen.getByLabelText('First name'), 'Max');
    await userEvent.selectOptions(select, 'Grandchild');
    await savePerson('Add person');
    await waitFor(() => expect(api.called('POST', '/recipients')).toHaveLength(1));
    expect(api.called('POST', '/recipients')[0].body).toMatchObject({ relationship: 'Grandchild' });
  });

  it('Other needs text; switching away keeps the text but sends only the chosen option', async () => {
    const api = routeFetch({ 'POST /recipients': json(201, { id: 'r9' }) });
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    await userEvent.type(screen.getByLabelText('First name'), 'Max');
    const select = screen.getByLabelText(/^Relationship/);
    await userEvent.selectOptions(select, 'Other');
    const other = screen.getByLabelText('Please specify the relationship');
    await userEvent.type(other, '   ');
    await savePerson('Add person');
    expect(await screen.findByText('Please specify the relationship.')).toBeInTheDocument();
    expect(api.called('POST', '/recipients')).toHaveLength(0);
    await userEvent.clear(other);
    await userEvent.type(other, 'Godmother');
    await userEvent.selectOptions(select, 'Friend');
    expect(screen.getByLabelText('Please specify the relationship')).not.toBeVisible();
    await userEvent.selectOptions(select, 'Other');
    expect(screen.getByLabelText('Please specify the relationship')).toHaveValue('Godmother');
    await userEvent.selectOptions(select, 'Friend');
    await savePerson('Add person');
    await waitFor(() => expect(api.called('POST', '/recipients')).toHaveLength(1));
    expect(api.called('POST', '/recipients')[0].body).toMatchObject({ relationship: 'Friend' });
  });

  it('edit: a saved custom value reopens as Other with its text, and round-trips', async () => {
    const api = routeFetch({
      'GET /recipients/r1': json(200, sofia),
      'PATCH /recipients/r1': json(200, sofia),
    });
    renderWithClient(<EditRecipient id="r1" />);
    expect(await screen.findByLabelText(/^Relationship/)).toHaveValue('Other');
    expect(screen.getByLabelText('Please specify the relationship')).toHaveValue('Daughter');
    await savePerson('Save changes');
    await waitFor(() => expect(api.called('PATCH', '/recipients/r1')).toHaveLength(1));
    expect(api.called('PATCH', '/recipients/r1')[0].body).toMatchObject({ relationship: 'Daughter' });
  });

  it('edit: a saved choice reopens selected; custom text is shown as plain text', async () => {
    routeFetch({ 'GET /recipients/r1': json(200, { ...sofia, relationship: 'Partner' }) });
    const { unmount } = renderWithClient(<EditRecipient id="r1" />);
    expect(await screen.findByLabelText(/^Relationship/)).toHaveValue('Partner');
    expect(screen.getByLabelText('Please specify the relationship')).not.toBeVisible();
    unmount();
    routeFetch({ 'GET /recipients/r1': json(200, { ...sofia, relationship: '<b>Aunty</b>' }) });
    const { container } = renderWithClient(<RecipientDetail id="r1" />);
    expect(await screen.findAllByText('<b>Aunty</b>')).not.toHaveLength(0);
    expect(container.querySelector('b')).toBeNull();
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

  it('a failed upload can be retried; its unconfirmed asset is removed at once (no reservation left)', async () => {
    fakeStorage(0);
    const api = routeFetch({
      'GET /recipients/r1': json(200, sofia),
      'POST /recipients/r1/photo/upload-url': uploadTarget('p3'),
      'DELETE /recipients/r1/photo/p3': new Response(null, { status: 204 }),
    });
    renderWithClient(<RecipientDetail id="r1" />);
    await screen.findByRole('button', { name: 'Add a photo' });
    await pick(png());
    expect(await screen.findByText(/couldn't upload this file/)).toBeInTheDocument();
    expect(api.called('DELETE', '/recipients/r1/photo/p3')).toHaveLength(1);
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

  it('a mobile-only contact: the number is read for its country and sent as E.164 (SMS sign-in)', async () => {
    const api = routeFetch({ 'GET /trusted-contacts': json(200, []), 'POST /trusted-contacts': json(201, { ...david, id: 't9' }) });
    renderWithClient(<NewTrustedContact />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    // jsdom's browser region is en-US: a visible, changeable default.
    expect(countryButton()).toHaveTextContent('United States (+1)');
    await fill({ 'First name': 'Maya', Mobile: '0491 570 006' });
    expect(await screen.findByText('Check this number: it doesn’t look like a valid number for United States.')).toBeInTheDocument();
    expect(api.called('POST', '/trusted-contacts')).toHaveLength(0);
    await pickCountry('austral', 'Australia (+61)');
    await userEvent.click(screen.getByRole('button', { name: 'Add trusted contact' }));
    await waitFor(() => expect(api.called('POST', '/trusted-contacts')).toHaveLength(1));
    expect(api.called('POST', '/trusted-contacts')[0].body).toMatchObject({ mobile: '+61491570006', email: null });
  });

  it('edit: a saved number opens on its own country and saves unchanged; an unreadable one is kept', async () => {
    const api = routeFetch({
      'GET /trusted-contacts': json(200, [david]),
      'GET /trusted-contacts/t1': json(200, { ...david, mobile: '+919876543210' }),
      'PATCH /trusted-contacts/t1': json(200, david),
    });
    const { unmount } = renderWithClient(<EditTrustedContact id="t1" />);
    expect(await screen.findByLabelText(/^Mobile/)).toHaveValue('098765 43210');
    expect(countryButton()).toHaveTextContent('India (+91)');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.called('PATCH', '/trusted-contacts/t1')).toHaveLength(1));
    expect(api.called('PATCH', '/trusted-contacts/t1')[0].body).toMatchObject({ mobile: '+919876543210' });
    unmount();

    const legacy = routeFetch({
      'GET /trusted-contacts': json(200, [david]),
      'GET /trusted-contacts/t1': json(200, { ...david, mobile: '+6140000' }),
      'PATCH /trusted-contacts/t1': json(200, david),
    });
    renderWithClient(<EditTrustedContact id="t1" />);
    expect(await screen.findByLabelText(/^Mobile/)).toHaveValue('+6140000');
    expect(screen.getByText(/couldn’t work out the country of this saved number/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(legacy.called('PATCH', '/trusted-contacts/t1')).toHaveLength(1));
    expect(legacy.called('PATCH', '/trusted-contacts/t1')[0].body).toMatchObject({ mobile: '+6140000' });
  });

  it('requires an email or a mobile', async () => {
    const api = routeFetch({ 'GET /trusted-contacts': json(200, []) });
    renderWithClient(<NewTrustedContact />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    await fill({ 'First name': 'David' });
    expect(await screen.findByText('Provide an email or a mobile (or both).')).toBeInTheDocument();
    expect(api.called('POST', '/trusted-contacts')).toHaveLength(0);
  });

  it('shows each card’s readiness: pending, with the sent date and a resend', async () => {
    routeFetch({ 'GET /trusted-contacts': json(200, [david]) });
    renderWithClient(<TrustedContactList />);
    expect(await screen.findByRole('link', { name: /David Smith/ })).toHaveTextContent('Invitation pending');
    const item = screen.getByRole('listitem', { name: 'David Smith' });
    expect(item).toHaveTextContent('Waiting for them to accept your invitation, sent by email on 1 Oct 2026.');
    expect(within(item).getByRole('button', { name: 'Resend invitation' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Trusted Contact readiness' })).toHaveTextContent('Your trusted contact isn’t ready yet.');
    // One contact: adding another is still offered.
    expect(screen.getByRole('link', { name: 'Add a trusted contact' })).toBeInTheDocument();
  });

  it('at two contacts the add action is gone and the limit is explained; 1 of 2 ready', async () => {
    routeFetch({ 'GET /trusted-contacts': json(200, [david, sarah]) });
    renderWithClient(<TrustedContactList />);
    expect(await screen.findByRole('link', { name: /Sarah Lee/ })).toHaveTextContent('Ready');
    const item = screen.getByRole('listitem', { name: 'Sarah Lee' });
    expect(item).toHaveTextContent('Setup complete. Invitation accepted 12 Oct 2026.');
    // Ready: nothing to resend, and no "mark as ready" anywhere.
    expect(within(item).queryByRole('button')).toBeNull();
    expect(screen.getByRole('region', { name: 'Trusted Contact readiness' })).toHaveTextContent('1 of 2 trusted contacts ready.');
    expect(screen.queryByRole('link', { name: 'Add a trusted contact' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('You can nominate up to 2 trusted contacts.');
  });

  it('both ready / one ready summaries', async () => {
    routeFetch({ 'GET /trusted-contacts': json(200, [sarah, { ...sarah, id: 't3', firstName: 'Tom' }]) });
    const { unmount } = renderWithClient(<TrustedContactList />);
    expect(await screen.findByText(/Both trusted contacts are ready\./)).toBeInTheDocument();
    unmount();
    routeFetch({ 'GET /trusted-contacts': json(200, [sarah]) });
    renderWithClient(<TrustedContactList />);
    expect(await screen.findByText(/Your trusted contact is ready\./)).toBeInTheDocument();
  });

  it('zero contacts: an invitation to add someone, no readiness summary', async () => {
    routeFetch({ 'GET /trusted-contacts': json(200, []) });
    renderWithClient(<TrustedContactList />);
    expect(await screen.findByRole('heading', { name: 'No trusted contacts yet' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Add a trusted contact' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'Trusted Contact readiness' })).toBeNull();
  });

  it('resend from the list: disabled while sending, success refreshes the card; a refusal is shown', async () => {
    let state = { ...david, readiness: { ...david.readiness, status: 'INVITATION_EXPIRED' } };
    let refuse = false;
    const api = routeFetch({
      'GET /trusted-contacts': () => json(200, [state]),
      'POST /trusted-contacts/t1/invitation': () => {
        if (refuse) return json(429, { statusCode: 429, message: 'Too many invitations. Please try again later.' });
        state = david;
        return json(200, david);
      },
    });
    renderWithClient(<TrustedContactList />);
    expect(await screen.findByRole('link', { name: /David Smith/ })).toHaveTextContent('Invitation expired');
    await userEvent.click(screen.getByRole('button', { name: 'Send a new invitation' }));
    expect(await screen.findByRole('button', { name: 'Resend invitation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /David Smith/ })).toHaveTextContent('Invitation pending');
    expect(api.called('POST', '/trusted-contacts/t1/invitation')).toHaveLength(1);
    refuse = true;
    // Stays disabled until the first send's list refresh has finished.
    const again = screen.getByRole('button', { name: 'Resend invitation' });
    await waitFor(() => expect(again).toBeEnabled());
    await userEvent.click(again);
    // A 429 is shown as the client's own safe wording.
    expect(await screen.findByText(/try again/i)).toHaveAttribute('role', 'alert');
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
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    await screen.findByLabelText(/^First name/);
    await fill({ 'First name': 'Zoe', Email: 'zoe@example.com' });
    expect(await screen.findByRole('alert')).toHaveTextContent('You can nominate up to 2 trusted contacts.');
  });

  it.each([
    ['INVITATION_PENDING', null, 'Resend invitation'],
    ['ACTION_NEEDED', 'DECLINED', 'Send a new invitation'],
    ['INVITATION_EXPIRED', null, 'Send a new invitation'],
    ['ACTION_NEEDED', 'NOT_SENT', 'Send invitation'],
  ])('%s %s: offers "%s", which posts to the invitation route', async (status, reason, label) => {
    const contact = { ...david, readiness: { ...david.readiness, status, reason } };
    const api = routeFetch({
      'GET /trusted-contacts/t1': json(200, contact),
      'POST /trusted-contacts/t1/invitation': json(200, david),
    });
    renderWithClient(<EditTrustedContact id="t1" />);
    await userEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(api.called('POST', '/trusted-contacts/t1/invitation')).toHaveLength(1));
    expect(await screen.findByText('Invitation pending')).toBeInTheDocument();
  });

  it('READY offers no resend on either channel', async () => {
    routeFetch({ 'GET /trusted-contacts/t1': json(200, { ...sarah, mobile: '+61400000000' }) });
    renderWithClient(<EditTrustedContact id="t1" />);
    expect(await screen.findByText('Setup complete. Invitation accepted 12 Oct 2026.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invitation/ })).not.toBeInTheDocument();
  });

  // 2026-10-17: invitations by email or SMS, the Customer's choice per send.
  describe('invitation channel', () => {
    const notSent = { status: 'ACTION_NEEDED', reason: 'NOT_SENT', invitationSentAt: null, invitationAcceptedAt: null };
    const moOnly = {
      ...david,
      email: null,
      mobile: '+61400000000',
      invitation: { status: 'NOT_SENT', sentAt: null, channel: null },
      readiness: notSent,
    };
    const smsSent = {
      ...moOnly,
      invitation: { status: 'PENDING', sentAt: '2026-10-01T00:00:00Z', channel: 'SMS' },
      readiness: david.readiness,
    };
    const both = { ...david, mobile: '+61400000000' };

    it('email only: one plain "Resend invitation" button that sends by email', async () => {
      const api = routeFetch({ 'GET /trusted-contacts': json(200, [david]), 'POST /trusted-contacts/t1/invitation': json(200, david) });
      renderWithClient(<TrustedContactList />);
      const button = await screen.findByRole('button', { name: 'Resend invitation' });
      expect(button).not.toHaveAttribute('aria-haspopup');
      await userEvent.click(button);
      await waitFor(() => expect(api.called('POST', '/trusted-contacts/t1/invitation')).toHaveLength(1));
      expect(api.called('POST', '/trusted-contacts/t1/invitation')[0].body).toEqual({ channel: 'EMAIL' });
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('mobile only: "Send invitation by SMS" → SMS sent, then pending "sent by SMS"', async () => {
      let state: object = moOnly;
      const api = routeFetch({
        'GET /trusted-contacts': () => json(200, [state]),
        'POST /trusted-contacts/t1/invitation': () => {
          state = smsSent;
          return json(200, smsSent);
        },
      });
      renderWithClient(<TrustedContactList />);
      const item = await screen.findByRole('listitem', { name: 'David Smith' });
      expect(item).toHaveTextContent('Invitation not sent');
      expect(item).not.toHaveTextContent(/Email needed|Add an email/);
      await userEvent.click(within(item).getByRole('button', { name: 'Send invitation by SMS' }));
      await waitFor(() => expect(api.called('POST', '/trusted-contacts/t1/invitation')).toHaveLength(1));
      expect(api.called('POST', '/trusted-contacts/t1/invitation')[0].body).toEqual({ channel: 'SMS' });
      expect(await within(item).findByText('Waiting for them to accept your invitation, sent by SMS on 1 Oct 2026.')).toBeInTheDocument();
      expect(within(item).getByText('Invitation pending')).toBeInTheDocument();
      expect(within(item).getByRole('button', { name: 'Resend invitation by SMS' })).toBeInTheDocument();
    });

    it('SMS provider failure: the safe message is shown, the card is not marked pending', async () => {
      routeFetch({
        'GET /trusted-contacts': json(200, [moOnly]),
        'POST /trusted-contacts/t1/invitation': json(503, {
          statusCode: 503,
          message: "We couldn't send the invitation just now. Please try again.",
        }),
      });
      renderWithClient(<TrustedContactList />);
      await userEvent.click(await screen.findByRole('button', { name: 'Send invitation by SMS' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/try again/i);
      expect(screen.getByRole('listitem', { name: 'David Smith' })).not.toHaveTextContent('Invitation pending');
    });

    it('both channels: a quiet menu with "Send by email" and "Send by SMS"; picking SMS sends SMS only', async () => {
      const api = routeFetch({ 'GET /trusted-contacts': json(200, [both]), 'POST /trusted-contacts/t1/invitation': json(200, both) });
      renderWithClient(<TrustedContactList />);
      const trigger = await screen.findByRole('button', { name: 'Resend invitation' });
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      await userEvent.click(trigger);
      const menu = await screen.findByRole('menu');
      expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Send by email', 'Send by SMS']);
      // Opening the menu sends nothing.
      expect(api.called('POST', '/trusted-contacts/t1/invitation')).toHaveLength(0);
      await userEvent.click(within(menu).getByRole('menuitem', { name: 'Send by SMS' }));
      await waitFor(() => expect(api.called('POST', '/trusted-contacts/t1/invitation')).toHaveLength(1));
      expect(api.called('POST', '/trusted-contacts/t1/invitation')[0].body).toEqual({ channel: 'SMS' });
    });

    it('both channels: fully keyboard operable (Enter opens, arrows move, Enter sends)', async () => {
      const api = routeFetch({ 'GET /trusted-contacts/t1': json(200, both), 'POST /trusted-contacts/t1/invitation': json(200, both) });
      renderWithClient(<EditTrustedContact id="t1" />);
      const trigger = await screen.findByRole('button', { name: 'Resend invitation' });
      trigger.focus();
      await userEvent.keyboard('{Enter}');
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Send by email' })).toHaveFocus());
      await userEvent.keyboard('{ArrowDown}');
      expect(within(menu).getByRole('menuitem', { name: 'Send by SMS' })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      expect(api.called('POST', '/trusted-contacts/t1/invitation')).toHaveLength(0);
      trigger.focus();
      await userEvent.keyboard('{Enter}');
      await screen.findByRole('menu');
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(api.called('POST', '/trusted-contacts/t1/invitation')).toHaveLength(1));
      expect(api.called('POST', '/trusted-contacts/t1/invitation')[0].body).toEqual({ channel: 'EMAIL' });
    });

    it('adding a mobile-only contact sends nothing automatically and says SMS is available', async () => {
      const api = routeFetch({ 'GET /trusted-contacts': json(200, []), 'POST /trusted-contacts': json(201, moOnly) });
      renderWithClient(<NewTrustedContact />);
      await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
      await fill({ 'First name': 'David', Mobile: '+61 400 000 000' });
      await waitFor(() => expect(api.called('POST', '/trusted-contacts')).toHaveLength(1));
      expect(api.called('POST', '/trusted-contacts/t1/invitation')).toHaveLength(0);
    });
  });

  it.each([
    ['email only', { Email: 'david@example.com' }, { email: 'david@example.com', mobile: null }],
    ['mobile only', { Mobile: '+61 400 000 000' }, { email: null, mobile: '+61400000000' }],
  ])('accepts %s', async (_name, fields, expected) => {
    const api = routeFetch({ 'GET /trusted-contacts': json(200, []), 'POST /trusted-contacts': json(201, david) });
    renderWithClient(<NewTrustedContact />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
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

describe('Free trial caps (Trial Step 3)', () => {
  const billing = (trialCaps: { recipients: number | null; trustedContacts: number | null }) =>
    json(200, { enabled: true, state: 'trial_active', enforced: true, hasAccess: true, trialEligible: false, trial: null, subscription: null, plans: [], canManageSubscription: false, trialCaps });
  const TRIAL = billing({ recipients: 1, trustedContacts: 1 });
  const PAID = billing({ recipients: null, trustedContacts: null });

  it('People I Love, trial person used: the add control shows Premium and opens an explanation with View plans and Close', async () => {
    routeFetch({ 'GET /recipients': json(200, page([sofia])), 'GET /billing': TRIAL });
    renderWithClient(<RecipientList />);
    const locked = await screen.findByRole('button', { name: /Add someone you love\s*Premium/ });
    expect(screen.queryByRole('link', { name: /Add someone you love/ })).not.toBeInTheDocument();
    await userEvent.click(locked);
    const dialog = await screen.findByRole('dialog', { name: 'Add more people with a plan' });
    expect(within(dialog).getByText(/includes one person/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(locked).toHaveFocus();
  });

  it('People I Love: no tier badge for a paid or exempt account, nor for the trial’s first person (empty state)', async () => {
    routeFetch({ 'GET /recipients': json(200, page([sofia])), 'GET /billing': PAID });
    const { unmount } = renderWithClient(<RecipientList />);
    expect(await screen.findByRole('link', { name: 'Add someone you love' })).toHaveAttribute('href', '/people/new');
    expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
    unmount();
    routeFetch({ 'GET /recipients': json(200, page([])), 'GET /billing': TRIAL });
    renderWithClient(<RecipientList />);
    expect(await screen.findByRole('link', { name: 'Add someone you love' })).toHaveAttribute('href', '/people/new');
    expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
  });

  it('/people/new opened with the trial person used: an explanation, not a form', async () => {
    routeFetch({ 'GET /recipients': json(200, page([sofia])), 'GET /billing': TRIAL });
    renderWithClient(<NewRecipient />);
    expect(await screen.findByRole('heading', { name: 'Add more people with a plan' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(screen.queryByRole('button', { name: 'Add person' })).not.toBeInTheDocument();
  });

  it('a stale form refused by the API (TRIAL_LIMIT) keeps what was typed and offers View plans', async () => {
    routeFetch({
      'GET /recipients': json(200, page([])),
      'GET /billing': TRIAL,
      'POST /recipients': json(409, { statusCode: 409, code: 'TRIAL_LIMIT', message: 'Your free trial includes one person. Choose a plan to add more.' }),
    });
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    await userEvent.type(await screen.findByLabelText('First name'), 'Mia');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('Your free trial includes one person. Choose a plan to add more.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(screen.getByLabelText('First name')).toHaveValue('Mia');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('a paid plan’s own limit (PLAN_LIMIT, Updated Plans Step 3): message shown, typing kept, no plan offer or upgrade promise', async () => {
    const message = 'Your plan includes up to 10 people in People I Love. To add someone new, remove someone first.';
    const api = routeFetch({
      'GET /recipients': json(200, page([sofia])),
      'POST /recipients': json(409, { statusCode: 409, error: 'Conflict', code: 'PLAN_LIMIT', message }),
    });
    renderWithClient(<NewRecipient />);
    await userEvent.type(await screen.findByLabelText('First name'), 'Mia');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View plans' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Mia');
    expect(router.push).not.toHaveBeenCalled();
    expect(api.called('POST', '/recipients')).toHaveLength(1);
  });

  it('a plain conflict (no code) gets no plan offer', async () => {
    routeFetch({ 'GET /recipients': json(200, page([])), 'POST /recipients': json(409, { statusCode: 409, message: 'Something else conflicted.' }) });
    renderWithClient(<NewRecipient />);
    await screen.findByLabelText('First name'); // Step 7: the form opens once the plan is known
    await userEvent.type(screen.getByLabelText('First name'), 'Mia');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('Something else conflicted.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View plans' })).not.toBeInTheDocument();
  });

  it('Trusted Contacts, trial contact used: Premium on the add control; paid: the normal link', async () => {
    routeFetch({ 'GET /trusted-contacts': json(200, [david]), 'GET /billing': TRIAL });
    const { unmount } = renderWithClient(<TrustedContactList />);
    await userEvent.click(await screen.findByRole('button', { name: /Add a trusted contact\s*Premium/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add another trusted contact with a plan' });
    expect(within(dialog).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    unmount();
    routeFetch({ 'GET /trusted-contacts': json(200, [david]), 'GET /billing': PAID });
    renderWithClient(<TrustedContactList />);
    expect(await screen.findByRole('link', { name: 'Add a trusted contact' })).toHaveAttribute('href', '/trusted-contacts/new');
    expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
  });

  it('Trusted Contacts at the two-contact maximum (e.g. from before the trial): no add control and no plan offer', async () => {
    routeFetch({ 'GET /trusted-contacts': json(200, [david, sarah]), 'GET /billing': TRIAL });
    renderWithClient(<TrustedContactList />);
    expect(await screen.findByText(/To choose someone else, open a contact and remove them first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a trusted contact/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
  });

  it('/trusted-contacts/new opened with the trial contact used: an explanation with View plans', async () => {
    routeFetch({ 'GET /trusted-contacts': json(200, [david]), 'GET /billing': TRIAL });
    renderWithClient(<NewTrustedContact />);
    expect(await screen.findByRole('heading', { name: 'Add another trusted contact with a plan' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(screen.queryByRole('button', { name: 'Add trusted contact' })).not.toBeInTheDocument();
  });
});
