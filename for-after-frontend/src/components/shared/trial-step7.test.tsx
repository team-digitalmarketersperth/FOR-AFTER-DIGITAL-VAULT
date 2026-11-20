import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { MemoryList, NewMemory } from '@/components/memory-vault/memories';
import { MessageDetail } from '@/components/messages/message-detail';
import { LinkedMemories, PromptEditor } from '@/components/prompts/prompts';
import { TrialQuestions } from '@/components/shared/trial-cap';
import type { CurrentUser } from '@/lib/api/auth';
import type { Prompt } from '@/lib/api/prompts';
import { clearLocalDrafts, localDraftKey, readLocalDraft, writeLocalDraft } from '@/lib/local-drafts';
import { BILLING_OFF, customer, json, renderWithClient, routeFetch, router } from '@/test/utils';

const path = vi.hoisted(() => ({ current: '/memory-vault' }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => path.current, useSearchParams: () => new URLSearchParams() }));

// Trial Step 7: the approved refinements (one trial memory, unlink after expiry, local-only draft copies) and the shared
// restriction UI (tier badge + dialog, counters, loading/retry instead of unrestricted).
const status = (over: object = {}) => ({
  ...BILLING_OFF,
  enabled: true,
  enforced: true,
  state: 'trial_active',
  hasAccess: true,
  trial: { startedAt: '2026-11-10T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z' },
  trialCaps: { recipients: 1, trustedContacts: 1, questions: 4, memories: 1 },
  questionsAnswered: 0,
  memoriesSaved: 0,
  features: { media: false, memoryLinks: false },
  ...over,
});
const EXPIRED = status({ state: 'trial_expired', hasAccess: false, trial: { startedAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-11-08T00:00:00.000Z' }, trialCaps: { recipients: null, trustedContacts: null, questions: null, memories: null }, features: { media: true, memoryLinks: true } });
const PAID = status({ state: 'paid_active', trialCaps: { recipients: null, trustedContacts: null, questions: null, memories: null }, features: { media: true, memoryLinks: true } });
const memory = { id: 'v1', title: 'Beach days', category: 'OTHER', textContent: 'A memory.', tags: [], createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z' };
const vaultRoutes = (billing: object | (() => Response), items: unknown[] = [memory]) => ({
  'GET /billing': typeof billing === 'function' ? (billing as () => Response) : json(200, billing),
  'GET /memory-vault': json(200, { items, pagination: { page: 1, limit: 25, total: items.length, pages: items.length ? 1 : 0 } }),
  'GET /memory-vault/tags': json(200, []),
});

afterEach(() => sessionStorage.clear());

describe('Memory Vault trial allowance (Step 7)', () => {
  it('one memory used: "1 of 1 trial memory used"; Save a memory shows Premium and opens the plan dialog (Escape returns focus)', async () => {
    routeFetch(vaultRoutes(status({ memoriesSaved: 1 })));
    renderWithClient(<MemoryList filters={{}} />);
    expect(await screen.findByText('1 of 1 trial memory used')).toBeInTheDocument();
    const pro = await screen.findByRole('button', { name: /Save a memory\s*Premium/ });
    expect(screen.queryByRole('link', { name: 'Save a memory' })).not.toBeInTheDocument();
    await userEvent.click(pro);
    const dialog = await screen.findByRole('dialog', { name: 'Save more memories with a plan' });
    expect(within(dialog).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(pro).toHaveFocus());
    // The memory itself stays listed and opens.
    expect(screen.getByRole('link', { name: /Beach days/ })).toHaveAttribute('href', '/memory-vault/v1');
  });

  it('none used: "0 of 1", Save a memory is the normal link; the count comes from the API, not the filtered list', async () => {
    routeFetch(vaultRoutes(status({ memoriesSaved: 0 }), []));
    renderWithClient(<MemoryList filters={{}} />);
    expect(await screen.findByText('0 of 1 trial memory used')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Save a memory' })[0]).toHaveAttribute('href', '/memory-vault/new');
  });

  it('paid and billing-off accounts see no counter and no tier badge', async () => {
    for (const billing of [PAID, BILLING_OFF]) {
      routeFetch(vaultRoutes({ ...billing, memoriesSaved: 5 }));
      const { unmount } = renderWithClient(<MemoryList filters={{}} />);
      expect(await screen.findByRole('link', { name: /Beach days/ })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('link', { name: 'Save a memory' })).toBeInTheDocument());
      expect(screen.queryByText(/trial memory used/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('/memory-vault/new at the cap explains with View plans and a way back, instead of the form', async () => {
    routeFetch(vaultRoutes(status({ memoriesSaved: 1 })));
    renderWithClient(<NewMemory />);
    expect(await screen.findByRole('heading', { name: 'Save more memories with a plan' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(screen.getByRole('link', { name: 'Back to Memory Vault' })).toHaveAttribute('href', '/memory-vault');
    expect(screen.queryByLabelText(/Title/)).not.toBeInTheDocument();
  });

  it('plan loading shows "Checking your plan…"; unreadable shows no form; once read the form opens (never unrestricted while unknown)', async () => {
    let ok = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const api = routeFetch(vaultRoutes(async () => {
      await gate;
      return ok ? json(200, status()) : json(500, { message: 'Down' });
    }));
    const { queryClient } = renderWithClient(<NewMemory />);
    expect(await screen.findByText('Checking your plan…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save memory' })).not.toBeInTheDocument();
    release();
    expect(await screen.findByText(/You can add something new once we’ve checked your plan/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save memory' })).not.toBeInTheDocument();
    ok = true;
    await queryClient.refetchQueries({ queryKey: ['billing'] });
    expect(await screen.findByRole('button', { name: 'Save memory' })).toBeInTheDocument();
    expect(api.called('POST', '/memory-vault')).toHaveLength(0);
  });

  it('a stale form refused with TRIAL_LIMIT keeps the typed title and offers View plans; the plan is re-read', async () => {
    const api = routeFetch({
      ...vaultRoutes(status()),
      'POST /memory-vault': json(409, { statusCode: 409, error: 'Conflict', code: 'TRIAL_LIMIT', message: 'Your free trial includes one written memory. Choose a plan to save more memories.' }),
    });
    renderWithClient(<NewMemory />);
    const title = await screen.findByLabelText(/Title/);
    await userEvent.type(title, 'Second memory');
    await userEvent.click(screen.getByRole('radio', { name: 'Recipes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    expect(await screen.findByText('Your free trial includes one written memory. Choose a plan to save more memories.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(title).toHaveValue('Second memory');
    await waitFor(() => expect(api.called('GET', '/billing').length).toBeGreaterThan(1));
    expect(screen.getByRole('button', { name: 'Save memory' })).toBeInTheDocument();
  });
});

describe('Unlinking after expiry (Step 7)', () => {
  const prompt = {
    key: 'childhood.earliest-memory',
    category: 'CHILDHOOD',
    version: 1,
    prompt: 'What is your earliest memory?',
    answered: true,
    response: { id: 'r1', promptKey: 'childhood.earliest-memory', textContent: 'A house by the sea.', privateNote: null, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z', mediaCount: 0, memories: [{ id: 'm1', title: 'Beach days', category: 'OTHER' }, { id: 'm2', title: 'Old house', category: 'OTHER' }] },
  } as unknown as Prompt;

  it('Unlink stays available and sends only the removal (DELETE …/memories with that id); never a PUT of the answer', async () => {
    const api = routeFetch({
      'GET /billing': json(200, EXPIRED),
      'DELETE /my-story/prompts/childhood.earliest-memory/response/memories': json(200, { ...prompt.response, memories: [] }),
      'GET /my-story/prompts': json(200, [prompt]),
    });
    renderWithClient(<LinkedMemories prompt={prompt} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink Beach days' }));
    await waitFor(() => expect(api.called('DELETE', '/my-story/prompts/childhood.earliest-memory/response/memories')).toHaveLength(1));
    expect(api.called('DELETE', '/my-story/prompts/childhood.earliest-memory/response/memories')[0].body).toEqual({ memoryVaultItemIds: ['m1'] });
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('a refused unlink shows the API message and keeps the links listed', async () => {
    routeFetch({
      'GET /billing': json(200, EXPIRED),
      'DELETE /my-story/prompts/childhood.earliest-memory/response/memories': json(400, { statusCode: 400, error: 'Bad Request', message: 'One or more memories are not linked to this answer.' }),
    });
    renderWithClient(<LinkedMemories prompt={prompt} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink Old house' }));
    expect(await screen.findByText('One or more memories are not linked to this answer.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Old house' })).toBeInTheDocument();
  });
});

describe('Unscheduling after expiry (Step 7)', () => {
  it('Unschedule stays (without promising editing) and sends the DELETE; Change timing opens the plan dialog', async () => {
    const message = { id: 'm1', title: 'For Sofia', contentType: 'TEXT', textContent: 'Dear Sofia,', privateNote: null, status: 'SCHEDULED', createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z', recipients: [{ id: 'r1', firstName: 'Sofia', lastName: null, relationship: null }], version: 1 };
    const schedule = { id: 's1', triggerType: 'ON_DEATH', scheduledFor: null, afterDeathDays: null, timezone: null, localTime: null, annualMonth: null, annualDay: null, eventDate: null, eventLabel: null, releasedRecipientCount: 0, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z' };
    const api = routeFetch({
      'GET /billing': json(200, EXPIRED),
      'GET /messages/m1': json(200, message),
      'GET /messages/m1/media': json(200, []),
      'GET /messages/m1/schedule': json(200, schedule),
      'GET /recipients': json(200, { items: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } }),
      'DELETE /messages/m1/schedule': new Response(null, { status: 204 }),
    });
    renderWithClient(<MessageDetail id="m1" />);
    const prompt = await screen.findByRole('dialog', { name: 'Your free trial has ended' });
    await userEvent.click(within(prompt).getByRole('button', { name: 'Continue viewing' }));
    expect(screen.queryByRole('button', { name: 'Unschedule to edit' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Change timing' }));
    const plan = await screen.findByRole('dialog', { name: 'Your free trial has ended' });
    await userEvent.click(within(plan).getByRole('button', { name: 'Close' }));
    await userEvent.click(screen.getByRole('button', { name: 'Unschedule' }));
    const confirm = await screen.findByRole('dialog', { name: 'Unschedule this message?' });
    expect(within(confirm).getByText(/Scheduling it again needs a plan/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Unschedule' }));
    await waitFor(() => expect(api.called('DELETE', '/messages/m1/schedule')).toHaveLength(1));
    expect(api.calls.filter((c) => ['POST', 'PATCH', 'PUT'].includes(c.method))).toHaveLength(0);
  });
});

describe('Unsaved words after expiry: kept in this tab only, per account (Step 7)', () => {
  it('keys carry the account; signing in as someone else or signing out removes the other account’s copies', () => {
    const a = localDraftKey('user-a', 'MY_WISHES', 'ceremony.style');
    const b = localDraftKey('user-b', 'MY_WISHES', 'ceremony.style');
    expect(a).not.toBe(b);
    writeLocalDraft(a, { textContent: 'A’s words' });
    writeLocalDraft(b, { textContent: 'B’s words' });
    sessionStorage.setItem('unrelated', 'kept');
    clearLocalDrafts('user-b');
    expect(readLocalDraft(a)).toBeNull();
    expect(readLocalDraft<{ textContent: string }>(b)?.payload.textContent).toBe('B’s words');
    clearLocalDrafts(null);
    expect(readLocalDraft(b)).toBeNull();
    expect(sessionStorage.getItem('unrelated')).toBe('kept');
  });

  const wish = (textContent: string) => ({
    key: 'ceremony.style',
    category: 'CEREMONY',
    version: 1,
    prompt: 'What kind of ceremony would you like?',
    answered: true,
    response: { id: 'r1', promptKey: 'ceremony.style', textContent, privateNote: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', mediaCount: 0 },
  });
  const routes = (billing: object, extra: Parameters<typeof routeFetch>[0] = {}) =>
    routeFetch({
      'GET /auth/me': json(200, customer),
      'GET /billing': json(200, billing),
      'GET /my-wishes/prompts/ceremony.style': json(200, wish('Something small.')),
      'GET /my-wishes/notice': json(200, { version: 1, text: 'N' }),
      'GET /my-wishes/prompts/ceremony.style/response/media': json(200, []),
      'GET /users/me/drafts/MY_WISHES/ceremony.style': new Response(null, { status: 204 }),
      ...extra,
    });

  it('a refused autosave is labelled "Not saved to your account", kept for this account only, offered on reopen and never sent by itself', async () => {
    const refused = () => json(402, { statusCode: 402, error: 'Payment Required', code: 'TRIAL_EXPIRED', message: 'Your free trial or plan has ended. Choose a plan to continue.' });
    routes(status(), { 'PUT /users/me/drafts/MY_WISHES/ceremony.style': refused });
    const first = renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    const box = await screen.findByLabelText('Your answer');
    await waitFor(() => expect(box).not.toHaveAttribute('readonly'));
    await userEvent.type(box, ' By the sea.');
    expect(await screen.findByText('Not saved to your account.', {}, { timeout: 5000 })).toBeInTheDocument();
    const key = localDraftKey(customer.id, 'MY_WISHES', 'ceremony.style');
    await waitFor(() => expect(readLocalDraft<{ textContent: string }>(key)?.payload.textContent).toBe('Something small. By the sea.'));
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith('for-after:unsaved:'))).toEqual([key]);
    first.unmount();

    // Reopened (e.g. after a reload or upgrade): offered with the same label; restoring fills the box and sends nothing.
    const api = routes(PAID, { 'PUT /users/me/drafts/MY_WISHES/ceremony.style': refused });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    const notice = await screen.findByRole('region', { name: 'Unsaved changes found' });
    expect(within(notice).getByText('Not saved to your account.')).toBeInTheDocument();
    expect(within(notice).getByText(/temporary/)).toBeInTheDocument();
    await userEvent.click(within(notice).getByRole('button', { name: 'Restore changes' }));
    expect(await screen.findByLabelText('Your answer')).toHaveValue('Something small. By the sea.');
    expect(api.called('PUT', '/my-wishes/prompts/ceremony.style/response')).toHaveLength(0);
  }, 20_000);

  it('another account never sees the copy', async () => {
    writeLocalDraft(localDraftKey('someone-else', 'MY_WISHES', 'ceremony.style'), { textContent: 'Not yours.' });
    routes(PAID);
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByLabelText('Your answer')).toHaveValue('Something small.');
    expect(screen.queryByRole('region', { name: 'Unsaved changes found' })).not.toBeInTheDocument();
  });
});

describe('Consistent plan status inside the shell (Step 7)', () => {
  const user: CurrentUser = { ...customer, id: '11111111-1111-4111-8111-111111111111' };
  it('an unreadable plan shows one "Check plan again" (the shell’s), not a second one from the page', async () => {
    path.current = '/my-story';
    routeFetch({ 'GET /billing': json(500, { message: 'Down' }), 'GET /death-verification/me': json(200, null) });
    renderWithClient(
      <DashboardShell user={user}>
        <TrialQuestions />
      </DashboardShell>,
    );
    expect(await screen.findByRole('button', { name: 'Check plan again' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Check plan again' })).toHaveLength(1);
  });
});
