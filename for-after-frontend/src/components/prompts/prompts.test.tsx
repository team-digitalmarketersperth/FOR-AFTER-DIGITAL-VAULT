import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Prompt } from '@/lib/api/prompts';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { answerSchema } from '@/schemas/vault';
import { PromptEditor, PromptList } from './prompts';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/my-story' }));

const prompt = (over: Partial<Prompt> = {}): Prompt => ({
  key: 'childhood.home',
  category: 'CHILDHOOD',
  version: 1,
  prompt: 'What was the place you grew up in like?',
  answered: false,
  response: null,
  ...over,
});
const answered = prompt({
  key: 'family.tradition',
  category: 'FAMILY',
  prompt: 'Is there a family tradition you love?',
  answered: true,
  response: {
    id: 'x',
    promptKey: 'family.tradition',
    textContent: 'Sunday lunch.',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  },
});

describe('My Story', () => {
  it('loads the catalogue from the API, with progress and category filter', async () => {
    routeFetch({ 'GET /my-story/prompts': json(200, [prompt(), answered]) });
    renderWithClient(<PromptList area="my-story" category="FAMILY" />);
    expect(await screen.findByText('1 of 2 answered')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Childhood' })).toHaveAttribute('href', '/my-story?category=CHILDHOOD');
    expect(screen.getByRole('link', { name: /Is there a family tradition/ })).toHaveTextContent('Sunday lunch.');
    expect(screen.queryByText('What was the place you grew up in like?')).not.toBeInTheDocument();
    // My Story has no notice (and never asks the API for one).
    expect(screen.queryByRole('complementary', { name: 'Important' })).not.toBeInTheDocument();
  });

  it('saves the answer exactly as written with PUT', async () => {
    const api = routeFetch({
      'GET /my-story/prompts/childhood.home': json(200, prompt()),
      'PUT /my-story/prompts/childhood.home/response': json(200, answered.response),
    });
    renderWithClient(<PromptEditor area="my-story" promptKey="childhood.home" />);
    // Phase 14B: My Story text is optional (files/memories); My Wishes still needs words.
    await userEvent.type(await screen.findByLabelText('Your answer'), '  A small house by the sea.');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/my-story'));
    expect(api.called('PUT', '/my-story/prompts/childhood.home/response')[0].body).toEqual({
      textContent: '  A small house by the sea.',
    });
    expect(screen.queryByRole('button', { name: 'Delete answer' })).not.toBeInTheDocument();
  });

  it('edits and deletes an existing answer after confirming', async () => {
    const api = routeFetch({
      'GET /my-story/prompts/family.tradition': json(200, answered),
      'DELETE /my-story/prompts/family.tradition/response': new Response(null, { status: 204 }),
    });
    renderWithClient(<PromptEditor area="my-story" promptKey="family.tradition" />);
    expect(await screen.findByLabelText('Your answer')).toHaveValue('Sunday lunch.');
    await userEvent.click(screen.getByRole('button', { name: 'Delete answer' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete answer' }));
    await waitFor(() => expect(api.called('DELETE', '/my-story/prompts/family.tradition/response')).toHaveLength(1));
  });

  // Phase 14A: the V1 catalogue comes only from the API, in its order.
  it('shows the categories in the API’s order with readable labels (V1: Work, Travel, Life lessons)', async () => {
    routeFetch({
      'GET /my-story/prompts': json(200, [
        prompt({ key: 'childhood.school', category: 'CHILDHOOD', prompt: 'What do you remember most about your school days?' }),
        prompt({ key: 'work.first-job', category: 'WORK', prompt: 'What do you remember about your first job?' }),
        prompt({ key: 'travel.journey', category: 'TRAVEL', prompt: 'Tell us about a journey that stayed with you.' }),
        prompt({ key: 'life-lessons.younger-self', category: 'LIFE_LESSONS', prompt: 'What would you tell your younger self?' }),
      ]),
    });
    renderWithClient(<PromptList area="my-story" />);
    await screen.findByText('0 of 4 answered');
    const chips = within(screen.getByRole('navigation', { name: /categor/i }))
      .getAllByRole('link')
      .map((l) => l.textContent);
    expect(chips).toEqual(['All', 'Childhood', 'Work', 'Travel', 'Life lessons']);
    expect(screen.getByRole('link', { name: 'Work' })).toHaveAttribute('href', '/my-story?category=WORK');
    expect(screen.getByText('Tell us about a journey that stayed with you.')).toBeInTheDocument();
  });

  it('shows the wording an answer was written for when the question has been reworded since', async () => {
    const old = prompt({
      ...answered,
      prompt: 'What family tradition has meant the most to you?',
      response: { ...answered.response!, promptTextSnapshot: 'An earlier wording?', promptVersion: 1 },
    });
    routeFetch({ 'GET /my-story/prompts/family.tradition': json(200, old) });
    renderWithClient(<PromptEditor area="my-story" promptKey="family.tradition" />);
    expect(await screen.findByText(/You answered an earlier wording of this question/)).toHaveTextContent('An earlier wording?');
    expect(screen.getByLabelText('Your answer')).toHaveValue('Sunday lunch.');
  });

  it('no notice when the answer matches the current wording', async () => {
    const same = prompt({
      ...answered,
      response: { ...answered.response!, promptTextSnapshot: answered.prompt, promptVersion: 1 },
    });
    routeFetch({ 'GET /my-story/prompts/family.tradition': json(200, same) });
    renderWithClient(<PromptEditor area="my-story" promptKey="family.tradition" />);
    await screen.findByLabelText('Your answer');
    expect(screen.queryByText(/earlier wording/)).not.toBeInTheDocument();
  });

  it('allows 50,000 characters per My Story answer (approved), 20,000 for My Wishes', async () => {
    expect(answerSchema('my-story').safeParse({ textContent: 'x'.repeat(50_000) }).success).toBe(true);
    const over = answerSchema('my-story').safeParse({ textContent: 'x'.repeat(50_001) });
    expect(over.success).toBe(false);
    expect(over.error!.issues[0].message).toBe('Your answer is longer than 50,000 characters.');
    expect(answerSchema('my-wishes').safeParse({ textContent: 'x'.repeat(20_001) }).success).toBe(false);
    // Blank: both may be files (or memories) only (Phase 14B / 15B); sent as
    // null, and the server refuses an empty answer.
    expect(answerSchema('my-wishes').safeParse({ textContent: '  ' }).success).toBe(true);
    expect(answerSchema('my-story').safeParse({ textContent: '  ' }).success).toBe(true);
    // The editor's counter (shown near the limit) uses the My Story limit.
    const long = prompt({ ...answered, response: { ...answered.response!, textContent: 'x'.repeat(45_000) } });
    routeFetch({ 'GET /my-story/prompts/family.tradition': json(200, long) });
    renderWithClient(<PromptEditor area="my-story" promptKey="family.tradition" />);
    expect(await screen.findByText('45,000 / 50,000')).toBeInTheDocument();
  });

  it('shows a safe not-found state for an unknown prompt', async () => {
    routeFetch({ 'GET /my-story/prompts/nope.nope': json(404, { statusCode: 404, message: 'Prompt not found.' }) });
    renderWithClient(<PromptEditor area="my-story" promptKey="nope.nope" />);
    expect(await screen.findByText('We couldn’t find this prompt')).toBeInTheDocument();
  });
});

// Phase 15A (approved 2026-10-08): the notice comes only from the API; a
// Customer acknowledges its current version once before writing.
const NOTICE_TEXT = 'Notice text exactly as the API serves it.';
const notice = (over: object = {}) => ({
  version: 1,
  text: NOTICE_TEXT,
  requiresAcknowledgement: true,
  acknowledged: false,
  acknowledgedAt: null,
  ...over,
});
const wishPrompt = prompt({ key: 'ceremony.style', category: 'CEREMONY', prompt: 'What kind of gathering would you like?' });
const answeredWish = prompt({
  ...wishPrompt,
  answered: true,
  response: {
    id: 'w1',
    promptKey: 'ceremony.style',
    textContent: 'Something small, outdoors.',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  },
});

describe('My Wishes notice (Phase 15A)', () => {
  it('renders the notice exactly as served, on the list and the editor (no copy of its own)', async () => {
    routeFetch({
      'GET /my-wishes/disclaimer': json(200, notice({ acknowledged: true, acknowledgedAt: '2026-10-08T00:00:00Z' })),
      'GET /my-wishes/prompts': json(200, [wishPrompt]),
      'GET /my-wishes/prompts/ceremony.style': json(200, wishPrompt),
    });
    const { unmount } = renderWithClient(<PromptList area="my-wishes" />);
    expect(await screen.findByText(NOTICE_TEXT)).toBeInTheDocument();
    // The old hardcoded wording is gone from the frontend.
    expect(screen.queryByText(/not a will, legal document/)).not.toBeInTheDocument();
    // Already acknowledged for this version: not asked again.
    expect(screen.queryByRole('checkbox', { name: 'I have read this notice.' })).not.toBeInTheDocument();
    unmount();
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByText(NOTICE_TEXT)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Save answer' })).toBeEnabled();
  });

  it('first time: an unticked checkbox; Continue only after ticking; then writing opens', async () => {
    const api = routeFetch({
      'GET /my-wishes/disclaimer': json(200, notice()),
      'POST /my-wishes/disclaimer/acknowledgement': json(200, notice({ acknowledged: true, acknowledgedAt: '2026-10-08T00:00:00Z' })),
      'GET /my-wishes/prompts/ceremony.style': json(200, wishPrompt),
      'PUT /my-wishes/prompts/ceremony.style/response': json(200, {}),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    const box = await screen.findByRole('checkbox', { name: 'I have read this notice.' });
    expect(box).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    // Writing is closed until then.
    expect(await screen.findByRole('button', { name: 'Save answer' })).toBeDisabled();
    expect(screen.getByLabelText('Your answer')).toBeDisabled();
    expect(screen.getByText('Please acknowledge the notice above to write or change your wishes.')).toBeInTheDocument();
    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(api.called('POST', '/my-wishes/disclaimer/acknowledgement')).toHaveLength(1));
    expect(api.called('POST', '/my-wishes/disclaimer/acknowledgement')[0].body).toEqual({ version: 1 });
    await waitFor(() => expect(screen.getByLabelText('Your answer')).toBeEnabled());
    expect(screen.queryByRole('checkbox', { name: 'I have read this notice.' })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your answer'), 'Something small, outdoors.');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(api.called('PUT', '/my-wishes/prompts/ceremony.style/response')).toHaveLength(1));
  });

  it('a new version: the existing wish stays readable and deletable, writing waits for the new acknowledgement', async () => {
    const api = routeFetch({
      'GET /my-wishes/disclaimer': json(200, notice({ version: 2, text: 'A newer notice.' })),
      'GET /my-wishes/prompts/ceremony.style': json(200, answeredWish),
      'DELETE /my-wishes/prompts/ceremony.style/response': new Response(null, { status: 204 }),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByText('A newer notice.')).toBeInTheDocument();
    expect(await screen.findByLabelText('Your answer')).toHaveValue('Something small, outdoors.');
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete answer' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete answer' }));
    await waitFor(() => expect(api.called('DELETE', '/my-wishes/prompts/ceremony.style/response')).toHaveLength(1));
    expect(api.calls.some((c) => c.method === 'PUT' || c.method === 'POST')).toBe(false);
  });

  it('if the notice cannot load: a calm error with retry, no guessed wording, no writing', async () => {
    routeFetch({
      'GET /my-wishes/disclaimer': json(500, { message: 'Internal server error' }),
      'GET /my-wishes/prompts/ceremony.style': json(200, wishPrompt),
      'GET /my-wishes/prompts/ceremony.style/response/media': json(200, []),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByText(/couldn’t load the My Wishes notice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText(/not a will/)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Save answer' })).toBeDisabled();
    // Phase 15B: no files can be added either.
    expect(screen.queryByRole('button', { name: 'Add a photo' })).not.toBeInTheDocument();
  });

  it('an acknowledgement error is shown and the box stays as the Customer left it', async () => {
    routeFetch({
      'GET /my-wishes/disclaimer': json(200, notice()),
      'POST /my-wishes/disclaimer/acknowledgement': json(409, {
        message: 'The My Wishes notice has changed. Please read the current version.',
      }),
      'GET /my-wishes/prompts': json(200, [wishPrompt]),
    });
    renderWithClient(<PromptList area="my-wishes" />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'I have read this notice.' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('The My Wishes notice has changed. Please read the current version.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'I have read this notice.' })).toBeChecked();
  });
});
