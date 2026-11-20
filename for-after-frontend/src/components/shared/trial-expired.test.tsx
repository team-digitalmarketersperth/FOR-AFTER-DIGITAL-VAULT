import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Link from 'next/link';
import { describe, expect, it, vi } from 'vitest';
import { PlanPage } from '@/components/account/plan';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { MediaManager } from '@/components/media/media-manager';
import { MessageDetail } from '@/components/messages/message-detail';
import { PromptEditor } from '@/components/prompts/prompts';
import type { CurrentUser } from '@/lib/api/auth';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';

const path = vi.hoisted(() => ({ current: '/messages' }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => path.current, useSearchParams: () => new URLSearchParams() }));

// Trial Step 6: an ended trial (billing on, hasAccess false) is read-only: view, download and delete stay; creating and
// editing open the plan dialog. Paid states with old trial dates are not "expired". The API stays the authority (402).
const TITLE = 'Your free trial has ended';
const BODY = 'Choose a plan to keep creating and editing. You can still view, download and delete your existing content.';
const status = (over: object = {}) => ({
  enabled: true,
  state: 'trial_expired',
  enforced: true,
  hasAccess: false,
  trialEligible: false,
  trial: { startedAt: '2029-12-25T00:00:00.000Z', endsAt: '2030-01-01T00:00:00.000Z' },
  subscription: null,
  plans: [],
  canManageSubscription: false,
  trialCaps: { recipients: null, trustedContacts: null, questions: null },
  questionsAnswered: 1,
  features: { media: true, memoryLinks: true },
  ...over,
});
const EXPIRED = () => json(200, status());
const ACTIVE = () => json(200, status({ state: 'trial_active', hasAccess: true, trialCaps: { recipients: 1, trustedContacts: 1, questions: 4 }, features: { media: false, memoryLinks: false } }));
const user: CurrentUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'fiona.test@example.test',
  firstName: 'Fiona',
  lastName: 'Test',
  role: 'CUSTOMER',
  status: 'ACTIVE',
  emailVerifiedAt: '2026-10-31T00:00:00.000Z',
  twoFactorEnabled: false,
  createdAt: '2026-10-31T00:00:00.000Z',
};
const shell = (where: string, billing: Response | (() => Response), child = <p>Page content</p>) => {
  path.current = where;
  const api = routeFetch({ 'GET /billing': billing, 'GET /death-verification/me': json(200, null) });
  return { api, ...renderWithClient(<DashboardShell user={user}>{child}</DashboardShell>) };
};
const wish = (textContent: string | null) => ({
  key: 'ceremony.style',
  category: 'CEREMONY',
  version: 1,
  prompt: 'What kind of ceremony would you like?',
  answered: !!textContent,
  response: textContent
    ? { id: 'r1', promptKey: 'ceremony.style', textContent, privateNote: 'Mine.', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', mediaCount: 0 }
    : null,
});
const wishRoutes = (billing: Response | (() => Response), p = wish('Something small.'), extra: Parameters<typeof routeFetch>[0] = {}) =>
  routeFetch({
    'GET /billing': billing,
    'GET /my-wishes/prompts/ceremony.style': json(200, p),
    'GET /my-wishes/notice': json(200, { version: 1, text: 'N' }),
    'GET /my-wishes/prompts/ceremony.style/response/media': json(200, []),
    'GET /users/me/drafts/MY_WISHES/ceremony.style': new Response(null, { status: 204 }),
    ...extra,
  });

describe('Expired trial: read-only access (Step 6)', () => {
  it('banner: the approved heading, body and View plans; the page stays open (no redirect)', async () => {
    shell('/memory-vault', EXPIRED());
    const banner = await screen.findByRole('region', { name: TITLE });
    expect(within(banner).getByText(BODY)).toBeInTheDocument();
    expect(within(banner).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(screen.getByText('Page content')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('a link to a create/edit page opens the plan dialog instead of the form; Close returns focus to the link', async () => {
    shell('/messages', EXPIRED(), <Link href="/messages/new">New message</Link>);
    const link = await screen.findByRole('link', { name: 'New message' });
    await screen.findByRole('region', { name: TITLE });
    link.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: TITLE });
    expect(within(dialog).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(router.push).not.toHaveBeenCalledWith('/messages/new');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(link).toHaveFocus());
  });

  it.each([
    ['/messages/m1/edit', 'View it read-only', '/messages/m1'],
    ['/memory-vault/v1/create-message', 'View it read-only', '/memory-vault/v1'],
    ['/people/new', 'Back to the list', '/people'],
  ])('direct route %s explains and offers %s (no redirect loop)', async (where, label, href) => {
    shell(where, EXPIRED());
    expect(await screen.findByRole('heading', { name: TITLE, level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Page content')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['trial not started', { state: 'trial_available', trialEligible: true, trial: null }, 'Start your free trial'],
    ['payment pending', { state: 'payment_pending', trial: null }, 'Your payment hasn’t been confirmed yet'],
    ['plan ended', { state: 'access_ended' }, 'Your plan has ended'],
  ])('%s keeps its own explanation, never "trial ended"', async (_n, over, title) => {
    shell('/messages', json(200, status(over)));
    expect(await screen.findByRole('region', { name: title })).toBeInTheDocument();
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it.each([
    ['paid with old trial dates', { state: 'paid_active', hasAccess: true }],
    ['payment issue (still has access)', { state: 'payment_issue', hasAccess: true }],
    ['grandfathered', { state: 'trial_expired', enforced: false, hasAccess: true }],
    ['billing off', { enabled: false, enforced: false, hasAccess: true, state: 'no_billing_record' }],
  ])('%s: no expired banner, nothing locked', async (_n, over) => {
    shell('/messages/new', json(200, status(over)));
    expect(await screen.findByText('Page content')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it('plan unreadable: says so with Check plan again and hides nothing', async () => {
    shell('/messages', json(500, { message: 'Down' }));
    expect(await screen.findByRole('button', { name: 'Check plan again' })).toBeInTheDocument();
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });

  it('the plan is re-read when an active trial ends (one timer, no polling): the banner appears', async () => {
    let expired = false;
    // The trial ends in the past by 900 ms: the timer fires ~100 ms after mount.
    const endsAt = new Date(Date.now() - 900).toISOString();
    shell('/messages', () =>
      expired ? EXPIRED() : json(200, status({ state: 'trial_active', hasAccess: true, trial: { startedAt: endsAt, endsAt } })),
    );
    await screen.findByText('Page content');
    expired = true;
    expect(await screen.findByRole('region', { name: TITLE }, { timeout: 3000 })).toBeInTheDocument();
  });

  it('answer page: a saved answer is read-only with Edit answer → dialog; Delete stays; a new question offers Write your answer', async () => {
    wishRoutes(EXPIRED());
    const { unmount } = renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    const box = await screen.findByLabelText('Your answer');
    await waitFor(() => expect(box).toHaveAttribute('readonly'));
    expect(box).toHaveValue('Something small.');
    expect(screen.queryByRole('button', { name: 'Save answer' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete answer' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit answer' }));
    expect(await screen.findByRole('dialog', { name: TITLE })).toBeInTheDocument();
    unmount();
    wishRoutes(EXPIRED(), wish(null));
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByRole('button', { name: 'Write your answer' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Your answer')).not.toBeInTheDocument();
  });

  it('a form opened before expiry and saved after: refused, says it was not saved, keeps the text, offers View plans, never resubmits', async () => {
    let expired = false;
    const api = wishRoutes(() => (expired ? EXPIRED() : ACTIVE()), wish('Something small.'), {
      'PUT /my-wishes/prompts/ceremony.style/response': () =>
        json(402, { statusCode: 402, error: 'Payment Required', code: 'TRIAL_EXPIRED', message: 'Your free trial or plan has ended. Choose a plan to continue.' }),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    const box = await screen.findByLabelText('Your answer');
    await waitFor(() => expect(box).not.toHaveAttribute('readonly'));
    await userEvent.type(box, ' By the sea.');
    expired = true; // the trial ends while the form is open
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByText('This wasn’t saved. What you typed is still here.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    // The plan refetch after the refusal never swaps the open form for the read-only view.
    await waitFor(() => expect(api.called('GET', '/billing').length).toBeGreaterThan(1));
    expect(box).toHaveValue('Something small. By the sea.');
    expect(box).not.toHaveAttribute('readonly');
    expect(screen.queryByText('Your answer is saved')).not.toBeInTheDocument();
    expect(api.called('PUT', '/my-wishes/prompts/ceremony.style/response')).toHaveLength(1);
  });

  it('opening a message shows the prompt once (View plans / Continue viewing); it does not reopen on refetch; delete stays', async () => {
    const message = { id: 'm1', title: 'For Sofia', contentType: 'TEXT', textContent: 'Dear Sofia,', privateNote: null, status: 'DRAFT', version: 1, createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', recipients: [{ id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter' }] };
    const api = routeFetch({ 'GET /billing': () => EXPIRED(), 'GET /messages/m1': json(200, message), 'GET /messages/m1/media': json(200, []) });
    const { queryClient } = renderWithClient(<MessageDetail id="m1" />);
    const dialog = await screen.findByRole('dialog', { name: TITLE });
    expect(within(dialog).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue viewing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const before = api.called('GET', '/billing').length;
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(api.called('GET', '/billing').length).toBeGreaterThan(before));
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Dear Sofia,')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule this message' })).toBeInTheDocument();
  });

  it('media: adding opens the plan dialog; existing files stay listed with Remove', async () => {
    const file = { id: 'kept', kind: 'PHOTO', status: 'READY', originalFileName: 'kept.jpg', mimeType: 'image/jpeg', sizeBytes: 100, uploadedAt: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
    routeFetch({ 'GET /billing': EXPIRED(), 'GET /memory-vault/v1/media': json(200, [file]) });
    renderWithClient(<MediaManager scope={{ kind: 'memory-vault', id: 'v1' }} kinds={['PHOTO']} editable />);
    // Same label either way: wait until the plan is known (Step 4: unknown never locks), then click.
    await waitFor(() => expect(screen.queryByText('Checking your plan…')).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Remove kept.jpg' })).toBeEnabled();
    await userEvent.click(await screen.findByRole('button', { name: 'Add a photo' }));
    expect(await screen.findByRole('dialog', { name: TITLE })).toBeInTheDocument();
  });

  it('billing return: a success URL without a confirmed subscription unlocks nothing; unavailable checkout is explained', async () => {
    routeFetch({ 'GET /billing': () => EXPIRED() });
    renderWithClient(<PlanPage checkout="success" />);
    expect(await screen.findByText(/Confirming your subscription/)).toBeInTheDocument();
    expect(screen.queryByText('Your subscription is confirmed.')).not.toBeInTheDocument();
    expect(screen.getByText(/Plans can’t be bought online just yet/)).toBeInTheDocument();
  });

  it('autosave refused after expiry (402): says Not saved to your account, stops retrying, keeps the text', async () => {
    const api = wishRoutes(ACTIVE(), wish('Something small.'), {
      'PUT /users/me/drafts/MY_WISHES/ceremony.style': () =>
        json(402, { statusCode: 402, error: 'Payment Required', code: 'TRIAL_EXPIRED', message: 'Your free trial or plan has ended. Choose a plan to continue.' }),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    const box = await screen.findByLabelText('Your answer');
    await waitFor(() => expect(box).not.toHaveAttribute('readonly'));
    await userEvent.type(box, ' More.');
    expect(await screen.findByText('Not saved to your account.', {}, { timeout: 5000 })).toBeInTheDocument();
    await userEvent.type(box, ' Still typing.');
    await new Promise((r) => setTimeout(r, 3000));
    expect(api.called('PUT', '/users/me/drafts/MY_WISHES/ceremony.style')).toHaveLength(1);
    expect(box).toHaveValue('Something small. More. Still typing.');
  }, 15_000);
});
