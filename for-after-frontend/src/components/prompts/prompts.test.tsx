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
    privateNote: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  },
});

describe('My Story', () => {
  it('My Wishes keeps its plain progress line (no bar, no photo)', async () => {
    routeFetch({ 'GET /my-wishes/prompts': json(200, [prompt({ key: 'ceremony.style', category: 'CEREMONY' })]), 'GET /my-wishes/notice': json(200, { version: 1, text: 'N' }) });
    const { container } = renderWithClient(<PromptList area="my-wishes" />);
    expect(await screen.findByText('0 of 1 answered')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('My Wishes keeps its own header, without the My Story introduction', async () => {
    routeFetch({ 'GET /my-wishes/prompts': json(200, []), 'GET /my-wishes/notice': json(200, { version: 1, text: 'N' }) });
    renderWithClient(<PromptList area="my-wishes" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('My Wishes');
    expect(screen.queryByText(/Follow thoughtful prompts/)).not.toBeInTheDocument();
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
      privateNote: null,
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
    expect(answerSchema('my-story').safeParse({ textContent: 'x'.repeat(50_000), privateNote: '' }).success).toBe(true);
    const over = answerSchema('my-story').safeParse({ textContent: 'x'.repeat(50_001), privateNote: '' });
    expect(over.success).toBe(false);
    expect(over.error!.issues[0].message).toBe('Your answer is longer than 50,000 characters.');
    expect(answerSchema('my-wishes').safeParse({ textContent: 'x'.repeat(20_001), privateNote: '' }).success).toBe(false);
    // Blank: both may be files (or memories) only (Phase 14B / 15B); sent as
    // null, and the server refuses an empty answer.
    expect(answerSchema('my-wishes').safeParse({ textContent: '  ', privateNote: '' }).success).toBe(true);
    expect(answerSchema('my-story').safeParse({ textContent: '  ', privateNote: '' }).success).toBe(true);
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

// Phase 15A: the notice comes only from the API. Informational since
// 2026-10-14: no checkbox, no Continue, nothing waits for an acknowledgement.
const NOTICE_TEXT = 'Notice text exactly as the API serves it.';
const notice = (over: object = {}) => ({
  version: 1,
  text: NOTICE_TEXT,
  requiresAcknowledgement: false,
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
    privateNote: null,
    textContent: 'Something small, outdoors.',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  },
});
const noGate = () => {
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByText('I have read this notice.')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
};

describe('My Wishes notice (informational)', () => {
  it('shows the notice exactly as served above the prompts, with no checkbox or Continue', async () => {
    routeFetch({
      'GET /my-wishes/disclaimer': json(200, notice()),
      'GET /my-wishes/prompts': json(200, [wishPrompt]),
      'GET /my-wishes/prompts/ceremony.style': json(200, wishPrompt),
    });
    const { unmount } = renderWithClient(<PromptList area="my-wishes" />);
    expect(await screen.findByText(NOTICE_TEXT)).toBeInTheDocument();
    expect(await screen.findByText('What kind of gathering would you like?')).toBeInTheDocument();
    // No copy of its own in the frontend.
    expect(screen.queryByText(/not a will, legal document/)).not.toBeInTheDocument();
    noGate();
    unmount();
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByText(NOTICE_TEXT)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Save answer' })).toBeEnabled();
    expect(screen.getByLabelText('Your answer')).toBeEnabled();
    noGate();
  });

  it('a Customer who never acknowledged writes and saves a wish straight away', async () => {
    const api = routeFetch({
      'GET /my-wishes/disclaimer': json(200, notice()),
      'GET /my-wishes/prompts/ceremony.style': json(200, wishPrompt),
      'PUT /my-wishes/prompts/ceremony.style/response': json(200, {}),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    await userEvent.type(await screen.findByLabelText('Your answer'), 'Something small, outdoors.');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(api.called('PUT', '/my-wishes/prompts/ceremony.style/response')).toHaveLength(1));
    expect(api.called('PUT', '/my-wishes/prompts/ceremony.style/response')[0].body).toEqual({
      textContent: 'Something small, outdoors.',
      privateNote: null,
    });
    expect(api.called('POST', '/my-wishes/disclaimer/acknowledgement')).toHaveLength(0);
  });

  it('an existing wish loads, can be edited and deleted, under any notice version', async () => {
    const api = routeFetch({
      'GET /my-wishes/disclaimer': json(200, notice({ version: 2, text: 'A newer notice.' })),
      'GET /my-wishes/prompts/ceremony.style': json(200, answeredWish),
      'PUT /my-wishes/prompts/ceremony.style/response': json(200, {}),
      'DELETE /my-wishes/prompts/ceremony.style/response': new Response(null, { status: 204 }),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByText('A newer notice.')).toBeInTheDocument();
    const box = await screen.findByLabelText('Your answer');
    expect(box).toHaveValue('Something small, outdoors.');
    await userEvent.type(box, ' With friends.');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(api.called('PUT', '/my-wishes/prompts/ceremony.style/response')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Delete answer' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete answer' }));
    await waitFor(() => expect(api.called('DELETE', '/my-wishes/prompts/ceremony.style/response')).toHaveLength(1));
    expect(api.called('POST', '/my-wishes/disclaimer/acknowledgement')).toHaveLength(0);
  });

  it('the form never waits for the notice: still loading, it is already usable', async () => {
    routeFetch({
      // Never answers (fetch is async, so a pending promise is fine at runtime).
      'GET /my-wishes/disclaimer': (() => new Promise<Response>(() => {})) as unknown as () => Response,
      'GET /my-wishes/prompts/ceremony.style': json(200, wishPrompt),
      'GET /my-wishes/prompts/ceremony.style/response/media': json(200, []),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByRole('button', { name: 'Save answer' })).toBeEnabled();
    expect(screen.getByLabelText('Your answer')).toBeEnabled();
    expect(screen.getByText('Loading the My Wishes notice')).toBeInTheDocument();
  });

  it('if the notice cannot load: a calm error with retry, no guessed wording, wishes still writable', async () => {
    routeFetch({
      'GET /my-wishes/disclaimer': json(500, { message: 'Internal server error' }),
      'GET /my-wishes/prompts/ceremony.style': json(200, wishPrompt),
      'GET /my-wishes/prompts/ceremony.style/response/media': json(200, []),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByText(/couldn’t load the My Wishes notice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText(/not a will/)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Save answer' })).toBeEnabled();
    noGate();
  });
});
