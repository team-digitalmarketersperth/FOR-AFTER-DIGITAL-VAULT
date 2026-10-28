import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Prompt, StoryBook } from '@/lib/api/prompts';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { CompanionProvider } from '@/components/companion/companion';
import { StoryWorkspace } from './story-workspace';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/my-story' }));

const response = (key: string, textContent: string) => ({
  id: `r-${key}`,
  promptKey: key,
  textContent,
  privateNote: 'kept private',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const prompt = (key: string, category: string, text: string, answer?: string): Prompt => ({
  key,
  category,
  version: 1,
  prompt: text,
  answered: !!answer,
  response: answer ? response(key, answer) : null,
});
const catalogue = [
  prompt('childhood.home', 'CHILDHOOD', 'What was the place you grew up in like?', 'A small house.'),
  prompt('childhood.school', 'CHILDHOOD', 'What do you remember about school?'),
  prompt('family.tradition', 'FAMILY', 'Is there a family tradition you love?'),
  prompt('life-lessons.younger-self', 'LIFE_LESSONS', 'What would you tell your younger self?'),
];
const noDraft = () => new Response(null, { status: 204 });
const routes = (extra: Record<string, Parameters<typeof routeFetch>[0][string]> = {}) =>
  routeFetch({
    'GET /my-story/prompts': json(200, catalogue),
    ...Object.fromEntries(catalogue.map((p) => [`GET /users/me/drafts/MY_STORY/${p.key}`, noDraft()])),
    ...Object.fromEntries(catalogue.map((p) => [`GET /my-story/prompts/${p.key}/response/media`, json(200, [])])),
    ...extra,
  });
const answer = () => screen.getByLabelText('Your answer');
const question = () => screen.getByRole('heading', { level: 2, name: /\?$/ });

describe('My Story workspace (approved design)', () => {
  it('replaces the photo hero with the approved header, tabs and real data', async () => {
    routes();
    const { container } = renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Every life holds a story.');
    expect(screen.getByText('Capture the memories and moments that made you.')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('My Story')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'View my book' })).toHaveAttribute('href', '/my-story/book');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Your answers', 'Chapters']);
    // Opens on the first unanswered question; the progress is the server's saved count for its chapter.
    expect(await screen.findByRole('heading', { name: 'What do you remember about school?' })).toBeInTheDocument();
    expect(screen.getByText('1 of 2 answers saved')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Childhood progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '2');
    expect(container.querySelector('img')).toBeNull();
    expect(container).not.toHaveTextContent(/download|pdf|share your book/i);
  });

  it('lists every category as a chapter with real counts, and every question is reachable', async () => {
    routes();
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    // The desktop list (the compact menu is the trigger above it, below lg).
    const nav = within(await screen.findByRole('navigation', { name: 'Your chapters' })).getByRole('list');
    expect(within(nav).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Childhood, 1 of 2 answers saved',
      'Family, 0 of 1 answers saved',
      'Life lessons, 0 of 1 answers saved',
    ]);
    await userEvent.click(screen.getByRole('button', { name: /Previous question/ }));
    const seen = [question().textContent];
    while (screen.getByRole('button', { name: /Next question/ }).hasAttribute('disabled') === false) {
      await userEvent.click(screen.getByRole('button', { name: /Next question/ }));
      seen.push(question().textContent);
    }
    expect(seen).toEqual(catalogue.map((p) => p.prompt));
    expect(answer()).toHaveValue('');
    // Selecting a chapter moves there and scopes the progress to it.
    await userEvent.click(within(nav).getByRole('button', { name: /^Family/ }));
    expect(question()).toHaveTextContent('Is there a family tradition you love?');
    expect(screen.getByText('0 of 1 answers saved')).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /^Family/ })).toHaveAttribute('aria-current', 'true');
  });

  it('compact chapter menu: real progress, vertical options, Stay here keeps the chapter and the text', async () => {
    const api = routes({ 'PUT /users/me/drafts/MY_STORY/childhood.school': (body) => json(200, body) });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    const trigger = await screen.findByRole('button', { name: 'Chapter: Childhood, 1 of 2 answers saved. Choose a chapter' });
    expect(trigger).toHaveTextContent('Childhood1/2');
    await userEvent.type(answer(), 'Unsaved words.');
    const before = api.calls.length;

    await userEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => [i.getAttribute('aria-label'), i.getAttribute('aria-checked')])).toEqual([
      ['Childhood, 1 of 2 answers saved', 'true'],
      ['Family, 0 of 1 answers saved', 'false'],
      ['Life lessons, 0 of 1 answers saved', 'false'],
    ]);
    // Escape closes without moving and returns focus to the trigger.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    // Opening and closing sent nothing.
    expect(api.calls.length).toBe(before);

    await userEvent.click(trigger);
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: /^Family/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stay here' }));
    expect(question()).toHaveTextContent('What do you remember about school?');
    expect(answer()).toHaveValue('Unsaved words.');
    expect(trigger).toHaveAccessibleName(/^Chapter: Childhood/);

    await userEvent.click(trigger);
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: /^Family/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard changes' }));
    expect(question()).toHaveTextContent('Is there a family tradition you love?');
    expect(screen.getByRole('button', { name: /^Chapter: Family, 0 of 1/ })).toBeInTheDocument();
    // Only the existing draft autosave of the typed text may write; the menu itself sends nothing.
    expect(api.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/users/me/drafts/'))).toEqual([]);
  });

  it('loads an existing answer and saves words + private note with PUT (files and links untouched)', async () => {
    const api = routes({ 'PUT /my-story/prompts/childhood.home/response': json(200, response('childhood.home', 'x')) });
    renderWithClient(<CompanionProvider><StoryWorkspace category="CHILDHOOD" /></CompanionProvider>);
    await screen.findByRole('heading', { name: 'What do you remember about school?' });
    await userEvent.click(screen.getByRole('button', { name: /Previous question/ }));
    expect(answer()).toHaveValue('A small house.');
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeDisabled();
    await userEvent.type(answer(), ' By the sea.');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByText('Your answer and private note are saved.')).toHaveAttribute('role', 'status');
    expect(api.called('PUT', '/my-story/prompts/childhood.home/response')[0].body).toEqual({
      textContent: 'A small house. By the sea.',
      privateNote: 'kept private',
    });
    // Still on the same question after the list refreshes.
    expect(question()).toHaveTextContent('What was the place you grew up in like?');
  });

  it('a failed save keeps the text and allows another try', async () => {
    routes({ 'PUT /my-story/prompts/childhood.school/response': json(500, { statusCode: 500, message: 'Something went wrong.' }) });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await userEvent.type(await screen.findByLabelText('Your answer'), 'Long walks to school.');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(answer()).toHaveValue('Long walks to school.');
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeEnabled();
    expect(screen.queryByText('Your answer and private note are saved.')).not.toBeInTheDocument();
  });

  it('refuses an answer over 50,000 characters without calling the API', async () => {
    const api = routes();
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    fireEvent.change(await screen.findByLabelText('Your answer'), { target: { value: 'x'.repeat(50_001) } });
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByText('Your answer is longer than 50,000 characters.')).toBeInTheDocument();
    expect(api.called('PUT', '/my-story/prompts/childhood.school/response')).toHaveLength(0);
  });

  it('is read-only while saving, so a late reply never overwrites newer typing', async () => {
    let reply!: (r: Response) => void;
    routes({ 'PUT /my-story/prompts/childhood.school/response': () => new Promise<Response>((r) => (reply = r)) as never });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await userEvent.type(await screen.findByLabelText('Your answer'), 'First draft.');
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(answer()).toHaveAttribute('readonly'));
    expect(screen.getByRole('button', { name: /Next question/ })).toBeDisabled();
    reply(json(200, response('childhood.school', 'First draft.')));
    await waitFor(() => expect(answer()).not.toHaveAttribute('readonly'));
    expect(answer()).toHaveValue('First draft.');
  });

  it('unsaved text: Stay here keeps it, Discard moves on, Save and continue saves first', async () => {
    const api = routes({ 'PUT /my-story/prompts/childhood.school/response': json(200, response('childhood.school', 'x')) });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await userEvent.type(await screen.findByLabelText('Your answer'), 'Unsaved words.');
    const next = () => userEvent.click(screen.getByRole('button', { name: /Next question/ }));

    await next();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stay here' }));
    expect(answer()).toHaveValue('Unsaved words.');
    expect(question()).toHaveTextContent('What do you remember about school?');

    await next();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(question()).toHaveTextContent('Is there a family tradition you love?'));
    expect(api.called('PUT', '/my-story/prompts/childhood.school/response')[0].body).toEqual({ textContent: 'Unsaved words.', privateNote: null });

    await userEvent.type(answer(), 'Thrown away.');
    await userEvent.click(screen.getByRole('button', { name: /Previous question/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard changes' }));
    expect(question()).toHaveTextContent('What do you remember about school?');
    expect(api.calls.filter((c) => c.method === 'PUT' && c.path.includes('/my-story/'))).toHaveLength(1);
  });

  it('Save and continue that fails stays on the question with the text kept', async () => {
    routes({ 'PUT /my-story/prompts/childhood.school/response': json(500, { statusCode: 500, message: 'Nope.' }) });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await userEvent.type(await screen.findByLabelText('Your answer'), 'Precious words.');
    await userEvent.click(screen.getByRole('link', { name: 'View my book' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and continue' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your text is still in the editor.');
    expect(router.push).not.toHaveBeenCalledWith('/my-story/book');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay here' }));
    expect(answer()).toHaveValue('Precious words.');
  });

  it('Help me write opens the shared companion for this question; the answer is sent only when included; a draft is not saved', async () => {
    const api = routes({ 'POST /assistant/reply': json(200, { reply: 'A polished school memory.', truncated: false }) });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await userEvent.type(await screen.findByLabelText('Your answer'), 'My notes.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // closed by default
    expect(screen.getAllByRole('button', { name: 'Open AI companion' })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Help me write' }));
    const panel = await screen.findByRole('dialog', { name: /For After companion/ });
    expect(panel).toHaveTextContent('For: What do you remember about school?');
    expect(panel).toHaveTextContent('Your private note, files and linked memories are never included.');
    expect(api.called('POST', '/assistant/reply')).toHaveLength(0); // opening sends nothing
    await userEvent.click(within(panel).getByRole('checkbox', { name: /Include the text in my answer box/ }));
    expect(within(panel).getByRole('blockquote')).toHaveTextContent('My notes.');
    await userEvent.click(within(panel).getByRole('button', { name: 'Polish my answer' }));
    expect(api.called('POST', '/assistant/reply')[0].body).toEqual({
      page: 'my-story',
      action: 'improve',
      source: 'My notes.',
      promptKey: 'childhood.school',
      history: [],
    });
    expect(JSON.stringify(api.calls)).not.toContain('kept private');
    await userEvent.click(await within(panel).findByRole('button', { name: 'Use this draft' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Help me write' })).toHaveFocus();
    expect(answer()).toHaveValue('A polished school memory.');
    // Placed, not saved: Save answer is still the only way, and it's now enabled.
    expect(api.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/response'))).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeEnabled();

    // Another question: the last one's text and replies are no longer in the companion.
    await userEvent.click(screen.getByRole('button', { name: /Previous question/ }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard changes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open AI companion' }));
    const again = await screen.findByRole('dialog', { name: /For After companion/ });
    expect(again).not.toHaveTextContent('A polished school memory.');
    expect(within(again).queryByRole('checkbox')).toBeNull();
  });

  it('Create chapter draft is honest that it is not available and generates nothing', async () => {
    const api = routes();
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await userEvent.click(await screen.findByRole('button', { name: 'Create chapter draft' }));
    expect(screen.getByText(/Chapter drafts aren’t available yet\. Nothing was sent anywhere/)).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('Chapters tab: the book’s chapters with links into the existing reader; text in the editor survives', async () => {
    const book: StoryBook = {
      chapters: [{ category: 'CHILDHOOD', entries: [{ promptKey: 'childhood.home', prompt: 'Q', textContent: 'A', mediaCount: 0, memories: [], updatedAt: '2026-09-01T00:00:00Z' }] }],
      unsorted: [],
    };
    routes({ 'GET /my-story/book': json(200, book) });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await userEvent.type(await screen.findByLabelText('Your answer'), 'Kept across tabs.');
    await userEvent.click(screen.getByRole('tab', { name: 'Chapters' }));
    expect(await screen.findByRole('link', { name: 'Read Childhood' })).toHaveAttribute('href', '/my-story/book?chapter=CHILDHOOD');
    expect(screen.getByText('1 saved answer')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Your answers' }));
    expect(answer()).toHaveValue('Kept across tabs.');
  });

  it('Chapters tab: empty state before any saved answer', async () => {
    routes({ 'GET /my-story/book': json(200, { chapters: [], unsorted: [] }) });
    renderWithClient(<CompanionProvider><StoryWorkspace /></CompanionProvider>);
    await userEvent.click(screen.getByRole('tab', { name: 'Chapters' }));
    expect(await screen.findByText('No chapters yet')).toBeInTheDocument();
  });
});
