import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CompanionProvider } from '@/components/companion/companion';
import type { Prompt } from '@/lib/api/prompts';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { PromptEditor, PromptList } from './prompts';
import { StoryWorkspace } from './story-workspace';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/my-wishes' }));

// Trial Step 5: four questions with written answers across My Story and My Wishes (GET /billing trialCaps.questions
// and questionsAnswered). Paid, exempt and billing-off accounts never see these locks.
const TITLE = 'Answer more questions with a plan';
const status = (questionsAnswered: number, trial = true) => ({
  enabled: true,
  state: trial ? 'trial_active' : 'paid_active',
  enforced: true,
  hasAccess: true,
  trialEligible: false,
  trial: null,
  subscription: null,
  plans: [],
  canManageSubscription: false,
  trialCaps: trial ? { recipients: 1, trustedContacts: 1, questions: 4 } : { recipients: null, trustedContacts: null, questions: null },
  questionsAnswered,
  features: { media: !trial, memoryLinks: !trial },
});
const response = (key: string, textContent: string | null) => ({
  id: `r-${key}`,
  promptKey: key,
  textContent,
  privateNote: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const prompt = (key: string, text: string, answer?: string): Prompt => ({
  key,
  category: 'CEREMONY',
  version: 1,
  prompt: text,
  answered: !!answer,
  response: answer ? response(key, answer) : null,
});
const answered = prompt('ceremony.style', 'What kind of ceremony would you like?', 'Something small.');
const open = prompt('ceremony.setting', 'Where would you like it to be held?');
const noDraft = () => new Response(null, { status: 204 });
const wishRoutes = (billing: Response | (() => Response | Promise<Response>), extra: Parameters<typeof routeFetch>[0] = {}) =>
  routeFetch({
    'GET /billing': billing,
    'GET /my-wishes/prompts': json(200, [answered, open]),
    'GET /my-wishes/notice': json(200, { version: 1, text: 'N' }),
    'GET /my-wishes/songs': json(200, []),
    ...Object.fromEntries([answered, open].flatMap((p) => [
      [`GET /my-wishes/prompts/${p.key}`, json(200, p)],
      [`GET /users/me/drafts/MY_WISHES/${p.key}`, noDraft()],
      [`GET /my-wishes/prompts/${p.key}/response/media`, json(200, [])],
    ])),
    ...extra,
  });
const expectProDialog = async () => {
  const dialog = await screen.findByRole('dialog', { name: TITLE });
  expect(within(dialog).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
  expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  return dialog;
};

describe('Trial question slots (Step 5)', () => {
  it('My Wishes list at the cap: shared counter; unanswered questions show Premium and open the plan dialog; answered stay editable', async () => {
    wishRoutes(json(200, status(4)));
    renderWithClient(<PromptList area="my-wishes" />);
    expect(await screen.findByText('4 of 4 trial questions answered')).toBeInTheDocument();
    const locked = await screen.findByRole('button', { name: /Where would you like it to be held\?.*Write your answer\s*Premium/ });
    expect(screen.queryByRole('link', { name: /Where would you like/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /What kind of ceremony/ })).toHaveAttribute('href', '/my-wishes/ceremony.style');
    await userEvent.click(locked);
    const dialog = await expectProDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(locked).toHaveFocus();
  });

  it('below the cap: the counter shows, nothing is locked', async () => {
    wishRoutes(json(200, status(2)));
    renderWithClient(<PromptList area="my-wishes" />);
    expect(await screen.findByText('2 of 4 trial questions answered')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Where would you like/ })).toBeInTheDocument();
    expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
  });

  it('paid or exempt: no trial counter and no locks', async () => {
    wishRoutes(json(200, status(9, false)));
    renderWithClient(<PromptList area="my-wishes" />);
    expect(await screen.findByRole('link', { name: /Where would you like/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/trial questions answered/)).not.toBeInTheDocument());
    expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
  });

  it('plan unreadable: says so with Check plan again; never shown as unlimited or locked', async () => {
    wishRoutes(json(500, { message: 'Down' }));
    renderWithClient(<PromptList area="my-wishes" />);
    expect(await screen.findByRole('button', { name: 'Check plan again' })).toBeInTheDocument();
    expect(screen.queryByText(/trial questions answered/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Where would you like/ })).toBeInTheDocument();
  });

  it('answer page at the cap: a new question explains instead of a form; an answered one stays editable', async () => {
    wishRoutes(json(200, status(4)));
    const { unmount } = renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.setting" />);
    await userEvent.click(await screen.findByRole('button', { name: /Write your answer\s*Premium/ }));
    await expectProDialog();
    expect(screen.queryByLabelText('Your answer')).not.toBeInTheDocument();
    unmount();
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByLabelText('Your answer')).toHaveValue('Something small.');
    expect(await screen.findByText('4 of 4 trial questions answered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Write your answer\s*Premium/ })).not.toBeInTheDocument();
  });

  it('new answer while the plan loads or can’t be read: a checking / retry state, never an open form', async () => {
    let reply: () => Response | Promise<Response> = () => new Promise<Response>(() => {}); // never answers
    wishRoutes(() => reply());
    const { unmount } = renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.setting" />);
    expect((await screen.findAllByText('Checking your plan…')).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Your answer')).not.toBeInTheDocument();
    unmount();
    reply = () => json(500, { message: 'Down' });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.setting" />);
    expect(await screen.findByText(/You can write a new answer once we’ve checked your plan/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Your answer')).not.toBeInTheDocument();
    // Retry once the plan is back: a free slot opens the form.
    reply = () => json(200, status(1));
    await userEvent.click(screen.getAllByRole('button', { name: 'Check plan again' })[0]);
    expect(await screen.findByLabelText('Your answer')).toBeInTheDocument();
  });

  it('a saved answer stays editable even while the plan can’t be read', async () => {
    wishRoutes(json(500, { message: 'Down' }));
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByLabelText('Your answer')).toHaveValue('Something small.');
  });

  it('paid: a new question opens its form with no counter or tier badge', async () => {
    wishRoutes(json(200, status(9, false)));
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.setting" />);
    expect(await screen.findByLabelText('Your answer')).toBeInTheDocument();
    expect(screen.queryByText(/trial questions answered/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Write your answer\s*Premium/ })).not.toBeInTheDocument();
  });

  it('a stale form refused with TRIAL_LIMIT keeps the typed text and links View plans', async () => {
    let used = 3;
    const api = wishRoutes(() => json(200, status(used)), {
      'PUT /my-wishes/prompts/ceremony.setting/response': () => {
        used = 4; // another tab used the last slot
        return json(409, { statusCode: 409, error: 'Conflict', code: 'TRIAL_LIMIT', message: 'Your free trial includes four answered questions across My Story and My Wishes. Choose a plan to answer more.' });
      },
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.setting" />);
    expect(await screen.findByText('3 of 4 trial questions answered')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your answer'), 'By the sea.');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByText(/Choose a plan to answer more/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    // The refusal re-reads the plan; the form (and what was typed) stays.
    expect(await screen.findByText('4 of 4 trial questions answered')).toBeInTheDocument();
    expect(screen.getByLabelText('Your answer')).toHaveValue('By the sea.');
    expect(api.called('PUT', '/my-wishes/prompts/ceremony.setting/response')).toHaveLength(1);
  });

  it('deleting an answer re-reads the shared count', async () => {
    let used = 4;
    const api = wishRoutes(() => json(200, status(used)), {
      'DELETE /my-wishes/prompts/ceremony.style/response': () => ((used = 3), new Response(null, { status: 204 })),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByText('4 of 4 trial questions answered')).toBeInTheDocument();
    const before = api.called('GET', '/billing').length;
    await userEvent.click(screen.getByRole('button', { name: 'Delete answer' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete answer' }));
    await waitFor(() => expect(api.called('GET', '/billing').length).toBeGreaterThan(before));
  });

  it('My Story workspace: the same counter; a new question at the cap shows Premium, the saved one stays editable', async () => {
    const story = [
      { ...prompt('childhood.home', 'What was the place you grew up in like?', 'A small house.'), category: 'CHILDHOOD' },
      { ...prompt('childhood.school', 'What do you remember about school?'), category: 'CHILDHOOD' },
    ];
    routeFetch({
      'GET /billing': json(200, status(4)),
      'GET /my-story/prompts': json(200, story),
      'GET /my-story/book': json(200, { chapters: [], unsorted: [] }),
      ...Object.fromEntries(story.flatMap((p) => [
        [`GET /users/me/drafts/MY_STORY/${p.key}`, noDraft()],
        [`GET /my-story/prompts/${p.key}/response/media`, json(200, [])],
      ])),
    });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    expect(await screen.findByText('4 of 4 trial questions answered')).toBeInTheDocument();
    // Starts at the first unanswered question: locked.
    await userEvent.click(await screen.findByRole('button', { name: /Write your answer\s*Premium/ }));
    await expectProDialog();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Previous question' }));
    expect(await screen.findByLabelText('Your answer')).toHaveValue('A small house.');
  });

  it('memory links in the trial: the picker shows Premium and explains; linked memories keep Unlink; paid keeps the picker', async () => {
    const withMemory = {
      ...prompt('childhood.home', 'What was the place you grew up in like?', 'A small house.'),
      category: 'CHILDHOOD',
    };
    withMemory.response = { ...withMemory.response!, memories: [{ id: 'm1', title: 'Beach days', category: 'OTHER' }] };
    const story = [withMemory, { ...prompt('childhood.school', 'What do you remember about school?'), category: 'CHILDHOOD' }];
    const storyRoutes = (billing: Response) =>
      routeFetch({
        'GET /billing': billing,
        'GET /my-story/prompts': json(200, story),
        'GET /my-story/book': json(200, { chapters: [], unsorted: [] }),
        ...Object.fromEntries(story.flatMap((p) => [
          [`GET /users/me/drafts/MY_STORY/${p.key}`, noDraft()],
          [`GET /my-story/prompts/${p.key}/response/media`, json(200, [])],
        ])),
      });
    storyRoutes(json(200, status(1)));
    const { unmount } = renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    const pro = await screen.findByRole('button', { name: /Choose from Memory Vault\s*Premium/ });
    pro.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Available with a paid plan' });
    expect(within(dialog).getByText('Your free trial includes written answers. For After Premium and Complete let you link memories from your Memory Vault.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(pro).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Previous question' }));
    expect(await screen.findByRole('button', { name: 'Unlink Beach days' })).toBeEnabled();
    unmount();
    storyRoutes(json(200, status(9, false)));
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    expect(await screen.findByRole('button', { name: 'Choose from Memory Vault' })).toBeInTheDocument();
    expect(screen.queryByText(/^(Premium|Complete)$/)).not.toBeInTheDocument();
  });
});
