import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Prompt } from '@/lib/api/prompts';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { MY_WISHES_DISCLAIMER, PromptEditor, PromptList } from './prompts';

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
    expect(screen.queryByText(MY_WISHES_DISCLAIMER)).not.toBeInTheDocument();
  });

  it('saves the answer exactly as written with PUT', async () => {
    const api = routeFetch({
      'GET /my-story/prompts/childhood.home': json(200, prompt()),
      'PUT /my-story/prompts/childhood.home/response': json(200, answered.response),
    });
    renderWithClient(<PromptEditor area="my-story" promptKey="childhood.home" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save answer' }));
    expect(await screen.findByText('Write something before saving.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your answer'), '  A small house by the sea.');
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

  it('shows a safe not-found state for an unknown prompt', async () => {
    routeFetch({ 'GET /my-story/prompts/nope.nope': json(404, { statusCode: 404, message: 'Prompt not found.' }) });
    renderWithClient(<PromptEditor area="my-story" promptKey="nope.nope" />);
    expect(await screen.findByText('We couldn’t find this prompt')).toBeInTheDocument();
  });
});

describe('My Wishes', () => {
  it('shows the exact non-legal disclaimer on the list and the editor', async () => {
    const api = routeFetch({
      'GET /my-wishes/prompts': json(200, [prompt({ key: 'ceremony.style', category: 'CEREMONY', prompt: 'What kind of gathering would you like?' })]),
      'GET /my-wishes/prompts/ceremony.style': json(200, prompt({ key: 'ceremony.style', category: 'CEREMONY' })),
      'PUT /my-wishes/prompts/ceremony.style/response': json(200, {}),
    });
    const { unmount } = renderWithClient(<PromptList area="my-wishes" />);
    expect(await screen.findByText(MY_WISHES_DISCLAIMER)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Ceremony' })).toBeInTheDocument();
    unmount();

    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    expect(await screen.findByText(MY_WISHES_DISCLAIMER)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Your answer'), 'Something small, outdoors.');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(api.called('PUT', '/my-wishes/prompts/ceremony.style/response')).toHaveLength(1));
    expect(MY_WISHES_DISCLAIMER).toBe(
      'My Wishes records personal preferences and guidance only. It is not a will, legal document, medical directive, financial instruction or substitute for professional advice.',
    );
  });
});
