import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageDetail } from '@/components/messages/message-detail';
import { PromptEditor } from '@/components/prompts/prompts';
import { ApiError } from '@/lib/api/errors';
import { localDraftKey, readLocalDraft, writeLocalDraft } from '@/lib/local-drafts';
import { makeQueryClient, resetPrivateCache } from '@/lib/query/query-client';
import { BILLING_OFF, customer, json, renderWithClient, routeFetch, router } from '@/test/utils';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/my-wishes', useSearchParams: () => new URLSearchParams() }));

// Step 7 close-out: the tab-only copy of a refused autosave. Exact text, one account only, cleared at each documented
// event, never sent by itself, and viewable (not editable) while the account is read-only.
const PREFIX = 'for-after:unsaved:';
const kept = () => Object.keys(sessionStorage).filter((k) => k.startsWith(PREFIX));
const status = (over: object = {}) => ({ ...BILLING_OFF, enabled: true, enforced: true, state: 'trial_active', hasAccess: true, trial: { startedAt: '2026-11-10T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z' }, trialCaps: { recipients: 1, trustedContacts: 1, questions: 4, memories: 1 }, memoriesSaved: 0, features: { media: false, memoryLinks: false }, ...over });
const ACTIVE = status();
const PAID = status({ state: 'paid_active', trialCaps: { recipients: null, trustedContacts: null, questions: null, memories: null }, features: { media: true, memoryLinks: true } });
const EXPIRED = status({ state: 'trial_expired', hasAccess: false, trialCaps: { recipients: null, trustedContacts: null, questions: null, memories: null } });
const refused = () => json(402, { statusCode: 402, error: 'Payment Required', code: 'TRIAL_EXPIRED', message: 'Your free trial or plan has ended. Choose a plan to continue.' });
const WISH_KEY = localDraftKey(customer.id, 'MY_WISHES', 'ceremony.style');
// Spaces, a tab, blank lines, curly quotes, an em dash and an emoji: kept byte for byte.
const EXACT = 'Something small.\n\n  Then the sea —\t“by the water” 🌊  \nLast line  ';
const wish = { key: 'ceremony.style', category: 'CEREMONY', version: 1, prompt: 'What kind of ceremony would you like?', answered: true, response: { id: 'r1', promptKey: 'ceremony.style', textContent: 'Something small.', privateNote: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', mediaCount: 0 } };
const routes = (billing: object, extra: Parameters<typeof routeFetch>[0] = {}) =>
  routeFetch({
    'GET /auth/me': json(200, customer),
    'GET /billing': json(200, billing),
    'GET /my-wishes/prompts/ceremony.style': json(200, wish),
    'GET /my-wishes/notice': json(200, { version: 1, text: 'N' }),
    'GET /my-wishes/prompts/ceremony.style/response/media': json(200, []),
    'GET /users/me/drafts/MY_WISHES/ceremony.style': new Response(null, { status: 204 }),
    ...extra,
  });
const writes = (api: ReturnType<typeof routeFetch>) => api.calls.filter((c) => c.method !== 'GET');

afterEach(() => sessionStorage.clear());

describe('Tab-only copy of a refused autosave (Step 7 close-out)', () => {
  it('keeps the exact text (spacing, blank lines, tabs, quotes, emoji) and restores it exactly; nothing is submitted', async () => {
    routes(ACTIVE, { 'PUT /users/me/drafts/MY_WISHES/ceremony.style': refused });
    const first = renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    const box = await screen.findByLabelText('Your answer');
    await waitFor(() => expect(box).not.toHaveAttribute('readonly'));
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste(EXACT);
    await screen.findByText('Not saved to your account.', {}, { timeout: 5000 });
    await waitFor(() => expect(readLocalDraft<{ textContent: string }>(WISH_KEY)?.payload.textContent).toBe(EXACT));
    first.unmount();

    const api = routes(PAID, { 'PUT /users/me/drafts/MY_WISHES/ceremony.style': refused });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    const notice = await screen.findByRole('region', { name: 'Unsaved changes found' });
    expect(within(notice).getByText(/may disappear when\s+you close this tab/)).toBeInTheDocument();
    await userEvent.click(within(notice).getByRole('button', { name: 'Restore changes' }));
    expect(await screen.findByLabelText('Your answer')).toHaveValue(EXACT);
    await new Promise((r) => setTimeout(r, 300));
    expect(api.called('PUT', '/my-wishes/prompts/ceremony.style/response')).toHaveLength(0);
  }, 20_000);

  it('the explicit Save, once allowed, removes the copy (the server holds the words now)', async () => {
    writeLocalDraft(WISH_KEY, { textContent: EXACT });
    const api = routes(PAID, { 'PUT /my-wishes/prompts/ceremony.style/response': json(200, { ...wish.response, textContent: EXACT }), 'PUT /users/me/drafts/MY_WISHES/ceremony.style': json(200, { key: 'ceremony.style' }) });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    await userEvent.click(await within(await screen.findByRole('region', { name: 'Unsaved changes found' })).findByRole('button', { name: 'Restore changes' }));
    expect(kept()).toEqual([WISH_KEY]); // restoring alone keeps it (not yet saved)
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(api.called('PUT', '/my-wishes/prompts/ceremony.style/response')).toHaveLength(1));
    expect(api.called('PUT', '/my-wishes/prompts/ceremony.style/response')[0].body).toMatchObject({ textContent: EXACT });
    await waitFor(() => expect(kept()).toEqual([]));
  });

  it('Discard in the recovery notice removes the copy and sends nothing', async () => {
    writeLocalDraft(WISH_KEY, { textContent: EXACT });
    const api = routes(PAID);
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    await userEvent.click(await within(await screen.findByRole('region', { name: 'Unsaved changes found' })).findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(kept()).toEqual([]));
    expect(writes(api)).toEqual([]);
  });

  it('clears at each documented event: sign-in as another account, sign-out, and session expiry (a 401)', async () => {
    const a = localDraftKey('user-a', 'MY_WISHES', 'ceremony.style');
    const b = localDraftKey('user-b', 'MESSAGE', 'm1');
    const client = makeQueryClient();
    writeLocalDraft(a, { textContent: 'A' });
    writeLocalDraft(b, { title: 'B' });
    await resetPrivateCache(client, { id: 'user-b' }); // B signs in on this tab
    expect(kept()).toEqual([b]);
    await resetPrivateCache(client, null); // sign-out
    expect(kept()).toEqual([]);
    writeLocalDraft(a, { textContent: 'A again' });
    // Session expiry: any private data request answered 401.
    await client.fetchQuery({ queryKey: ['messages'], queryFn: () => Promise.reject(new ApiError('unauthenticated', 401, 'Signed out')), retry: false }).catch(() => {});
    await waitFor(() => expect(kept()).toEqual([]));
  });

  it('another account’s copy is never offered or shown', async () => {
    writeLocalDraft(localDraftKey('someone-else', 'MY_WISHES', 'ceremony.style'), { textContent: 'Not yours.' });
    routes(EXPIRED);
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByRole('button', { name: 'Edit answer' })).toBeInTheDocument();
    expect(screen.queryByText('Unsaved draft in this tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Not yours.')).not.toBeInTheDocument();
  });
});

describe('“View unsaved draft” while read-only (Step 7 close-out)', () => {
  it('answer page: the copy is viewable as exact text, the answer stays read-only with no Save or Restore; Discard removes it', async () => {
    writeLocalDraft(WISH_KEY, { textContent: EXACT });
    const api = routes(EXPIRED);
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    const section = await screen.findByRole('region', { name: 'Unsaved draft in this tab' });
    expect(within(section).getByText('Not saved to your account.')).toBeInTheDocument();
    expect(within(section).getByText(/may disappear when you close the tab/)).toBeInTheDocument();
    const view = within(section).getByRole('button', { name: 'View unsaved draft' });
    expect(view).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(view);
    const shown = within(section).getByRole('region', { name: 'Unsaved draft' });
    expect(shown.textContent).toBe(EXACT);
    expect(within(section).getByRole('button', { name: 'Hide unsaved draft' })).toHaveAttribute('aria-expanded', 'true');
    // Viewing enables nothing: the saved answer is still read-only and there is no way to save or restore.
    const box = screen.getByLabelText('Your answer');
    expect(box).toHaveAttribute('readonly');
    expect(box).toHaveValue('Something small.');
    expect(screen.queryByRole('button', { name: 'Save answer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore changes' })).not.toBeInTheDocument();
    await userEvent.click(within(section).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Unsaved draft in this tab' })).not.toBeInTheDocument();
    expect(kept()).toEqual([]);
    expect(writes(api)).toEqual([]);
  });

  it('regression: the copy survives a reload where the account is known before the server draft lookup returns', async () => {
    writeLocalDraft(WISH_KEY, { textContent: EXACT });
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    routes(EXPIRED, { 'GET /users/me/drafts/MY_WISHES/ceremony.style': async () => (await slow, new Response(null, { status: 204 })) });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByRole('button', { name: 'Edit answer' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 200)); // user and plan known, draft lookup still pending
    expect(kept()).toEqual([WISH_KEY]);
    release();
    expect(await screen.findByRole('region', { name: 'Unsaved draft in this tab' })).toBeInTheDocument();
    expect(readLocalDraft<{ textContent: string }>(WISH_KEY)?.payload.textContent).toBe(EXACT);
  });

  it('message page: an unsaved edit kept in this tab is viewable while its edit page is closed', async () => {
    writeLocalDraft(localDraftKey(customer.id, 'MESSAGE', 'm1'), { title: 'For Sofia', contentType: 'TEXT', textContent: 'Dear Sofia,\n  more words ' });
    const message = { id: 'm1', title: 'For Sofia', contentType: 'TEXT', textContent: 'Dear Sofia,', privateNote: null, status: 'DRAFT', createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z', recipients: [], version: 1 };
    const api = routeFetch({ 'GET /auth/me': json(200, customer), 'GET /billing': json(200, EXPIRED), 'GET /messages/m1': json(200, message), 'GET /messages/m1/media': json(200, []) });
    renderWithClient(<MessageDetail id="m1" />);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue viewing' }));
    const section = await screen.findByRole('region', { name: 'Unsaved draft in this tab' });
    await userEvent.click(within(section).getByRole('button', { name: 'View unsaved draft' }));
    expect(within(section).getByRole('region', { name: 'Unsaved draft' }).textContent).toBe('For Sofia\n\nDear Sofia,\n  more words ');
    expect(writes(api)).toEqual([]);
  });

  it('paid accounts with a copy get the normal recovery offer instead (editing is open)', async () => {
    writeLocalDraft(WISH_KEY, { textContent: EXACT });
    routes(PAID);
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByRole('region', { name: 'Unsaved changes found' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Unsaved draft in this tab' })).not.toBeInTheDocument();
  });
});
