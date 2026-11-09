import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Prompt, StoryBook } from '@/lib/api/prompts';
import { customer, json, renderWithClient, routeFetch, router } from '@/test/utils';
import { chaptersOf, StoryBookReader, StoryChapters } from './story-book';

// The URL the reader sees; tests change it to play links and Back/Forward.
const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/my-story', useSearchParams: () => nav.search }));
const at = (chapter?: string) => (nav.search = new URLSearchParams(chapter ? { chapter } : {}));
afterEach(() => at());

const entry = (promptKey: string, prompt: string, textContent: string | null, over: object = {}) => ({
  promptKey,
  prompt,
  textContent,
  mediaCount: 0,
  memories: [],
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
});
const book: StoryBook = {
  chapters: [
    { category: 'CHILDHOOD', entries: [entry('childhood.home', 'What was the place you grew up in like?', 'A small house.\n\nA big garden,\nand a lemon tree.')] },
    { category: 'FAMILY', entries: [entry('family.tradition', 'Is there a family tradition you love?', 'Sunday lunch.')] },
    { category: 'TRAVEL', entries: [entry('travel.place', 'A place you still think about?', null, { mediaCount: 1 })] },
    { category: 'LIFE_LESSONS', entries: [entry('life-lessons.longest', 'What lesson took you the longest to learn?', 'Patience.')] },
  ],
  unsorted: [entry('gone.old', 'An old question?', 'Still kept.', { mediaCount: 2 })],
};
const prompt = (key: string, answered: boolean): Prompt => ({ key, category: 'CHILDHOOD', version: 1, prompt: key, answered, response: null });
const prompts = [prompt('a', true), prompt('b', true), prompt('c', false), prompt('d', false)];

describe('My Story book: chapters', () => {
  it('keeps the API’s catalogue order, labels categories, and adds unrecognised answers as a labelled last chapter', () => {
    expect(chaptersOf(book).map((c) => [c.key, c.title])).toEqual([
      ['CHILDHOOD', 'Childhood'],
      ['FAMILY', 'Family'],
      ['TRAVEL', 'Travel'],
      ['LIFE_LESSONS', 'Life lessons'],
      ['more', 'More of your story'],
    ]);
    expect(chaptersOf({ chapters: [], unsorted: [] })).toEqual([]);
  });
});

describe('Dashboard: Your story, chapter by chapter', () => {
  it('shows up to three chapter links, real progress and both actions; never the answers', async () => {
    routeFetch({ 'GET /my-story/book': json(200, book), 'GET /my-story/prompts': json(200, prompts) });
    renderWithClient(<StoryChapters />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Your story, chapter by chapter');
    expect(screen.getByText('Watch your memories come together into your life story.')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Your chapters' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Chapter 1Childhood', '/my-story/book?chapter=CHILDHOOD'],
      ['Chapter 2Family', '/my-story/book?chapter=FAMILY'],
      ['Chapter 3Travel', '/my-story/book?chapter=TRAVEL'],
    ]);
    expect(screen.getByText('and 2 more chapters')).toBeInTheDocument();
    // The existing calculation: answered prompts of the listed prompts.
    expect(screen.getByText('2 of 4 answered')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Preview My Story' })).toHaveAttribute('href', '/my-story/book');
    expect(screen.getByRole('link', { name: 'Continue writing' })).toHaveAttribute('href', '/my-story');
    expect(document.body).not.toHaveTextContent(/Sunday lunch|A small house/);
  });

  it('no saved content: the invitation, no invented chapters or progress', async () => {
    routeFetch({ 'GET /my-story/book': json(200, { chapters: [], unsorted: [] }), 'GET /my-story/prompts': json(200, prompts.map((p) => ({ ...p, answered: false }))) });
    renderWithClient(<StoryChapters />);
    // Loading first, never a flash of the empty state.
    expect(screen.getByLabelText('Loading your story')).toBeInTheDocument();
    expect(screen.queryByText('Your story begins with a memory.')).not.toBeInTheDocument();
    expect(await screen.findByText('Your story begins with a memory.')).toBeInTheDocument();
    expect(screen.getByText('Answer a few thoughtful prompts and watch your chapters take shape.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Begin your story' })).toHaveAttribute('href', '/my-story');
    expect(screen.queryByText(/Chapter \d/)).not.toBeInTheDocument();
    expect(screen.queryByText(/answered/)).not.toBeInTheDocument();
  });

  it('a failed load offers a retry', async () => {
    routeFetch({ 'GET /my-story/book': json(500, {}), 'GET /my-story/prompts': json(200, prompts) });
    renderWithClient(<StoryChapters />);
    expect(await screen.findByRole('button', { name: 'Try again' }, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe('Book reader', () => {
  it('cover with the owner’s name, contents, the chosen chapter in full, and previous/next', async () => {
    routeFetch({ 'GET /my-story/book': json(200, book), 'GET /auth/me': json(200, customer) });
    const { container } = renderWithClient((at('CHILDHOOD'), <StoryBookReader />));
    expect(await screen.findByRole('heading', { level: 1, name: 'My Story' })).toBeInTheDocument();
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('5 chapters')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to writing' })).toHaveAttribute('href', '/my-story');
    expect(screen.getByRole('heading', { level: 2, name: 'Childhood' })).toBeInTheDocument();
    // Exact words with their paragraph and line breaks.
    const text = screen.getByText(/A small house/);
    expect(text.textContent).toBe('A small house.\n\nA big garden,\nand a lemon tree.');
    expect(text).toHaveClass('whitespace-pre-wrap');
    expect(screen.getByRole('heading', { level: 3, name: 'What was the place you grew up in like?' })).toBeInTheDocument();
    // Only this chapter's answers.
    expect(screen.queryByText('Sunday lunch.')).not.toBeInTheDocument();
    const current = screen.getAllByRole('link', { current: 'page' });
    expect(current[0]).toHaveTextContent('Childhood');
    const pager = screen.getByRole('navigation', { name: 'Chapters' });
    expect(within(pager).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/my-story/book?chapter=FAMILY']);
    expect(within(pager).getByText('This is the first chapter').parentElement).toHaveAttribute('aria-disabled', 'true');
    // A private reading view: nothing to export, print, download or share.
    expect(screen.queryByRole('button', { name: /pdf|download|export|print|share/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /pdf|download|export|print|share/i })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/private note/i);
  });

  it('a media-only answer shows its real photo, whole; unrecognised answers are kept and labelled', async () => {
    routeFetch({
      'GET /my-story/book': json(200, book),
      'GET /auth/me': json(200, customer),
      'GET /my-story/prompts/travel.place/response/media': json(200, [
        { id: 'p1', kind: 'PHOTO', status: 'READY', originalFileName: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 1, uploadedAt: null, createdAt: '', updatedAt: '' },
        { id: 'p2', kind: 'PHOTO', status: 'PENDING_UPLOAD', originalFileName: 'q.jpg', mimeType: 'image/jpeg', sizeBytes: 1, uploadedAt: null, createdAt: '', updatedAt: '' },
      ]),
      'GET /my-story/prompts/travel.place/response/media/p1/access-url': json(200, { url: 'https://media.test/p1.jpg', expiresAt: '2030-01-01T00:00:00Z' }),
    });
    const travel = renderWithClient((at('TRAVEL'), <StoryBookReader />));
    const img = await screen.findByAltText('Photo saved with this answer');
    expect(img).toHaveAttribute('src', 'https://media.test/p1.jpg');
    expect(img).not.toHaveClass('object-cover');
    expect(screen.getAllByAltText('Photo saved with this answer')).toHaveLength(1);
    travel.unmount();

    renderWithClient((at('more'), <StoryBookReader />));
    expect(await screen.findByRole('heading', { level: 2, name: 'More of your story' })).toBeInTheDocument();
    expect(screen.getByText('Answers to questions that are no longer in the prompt list.')).toBeInTheDocument();
    expect(screen.getByText('Still kept.')).toBeInTheDocument();
    expect(screen.getByText('2 files saved with this answer can’t be shown here.')).toBeInTheDocument();
  });

  it('a chapter that no longer exists opens the first one with a note; an empty book invites writing', async () => {
    routeFetch({ 'GET /my-story/book': json(200, book), 'GET /auth/me': json(200, customer) });
    const r = renderWithClient((at('WORK'), <StoryBookReader />));
    expect(await screen.findByText('That chapter has no saved answers now, so here is the first one.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Childhood' })).toBeInTheDocument();
    r.unmount();

    routeFetch({ 'GET /my-story/book': json(200, { chapters: [], unsorted: [] }), 'GET /auth/me': json(200, customer) });
    renderWithClient((at(), <StoryBookReader />));
    expect(await screen.findByRole('link', { name: 'Begin your story' })).toHaveAttribute('href', '/my-story');
    expect(screen.queryByText(/Chapter \d/)).not.toBeInTheDocument();
  });
});

describe('Book reader: turning pages', () => {
  const open = async (chapter?: string) => {
    routeFetch({ 'GET /my-story/book': json(200, book), 'GET /auth/me': json(200, customer) });
    const view = renderWithClient((at(chapter), <StoryBookReader />));
    await screen.findByRole('navigation', { name: 'Chapters' });
    const pager = () => screen.getByRole('navigation', { name: 'Chapters' });
    const link = (name: RegExp) => within(pager()).getByRole('link', { name });
    // The router reporting the current URL again (Back/Forward, a contents link).
    const urlChanged = () =>
      act(() =>
        view.rerender(
          <QueryClientProvider client={view.queryClient}>
            <StoryBookReader />
          </QueryClientProvider>,
        ),
      );
    return { ...view, pager, link, urlChanged };
  };
  // A click, and the end of a turn with no animation to wait for.
  const click = (el: HTMLElement, init?: object) => act(async () => void fireEvent.click(el, init));
  const chapterTitle = () => screen.getByRole('heading', { level: 2, name: (_, el) => el.id === 'chapter-title' });
  // A controllable Web Animations API: each turn waits until finish() is called.
  const controlledAnimations = () => {
    const pending: Array<() => void> = [];
    const animate = vi.fn(() => {
      let done!: () => void;
      const finished = new Promise<void>((resolve) => (done = resolve));
      pending.push(done);
      return { finished, cancel: vi.fn() } as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true, writable: true });
    return {
      animate,
      finish: async () => {
        await act(async () => {
          for (const done of pending.splice(0)) done();
        });
      },
    };
  };
  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    vi.unstubAllGlobals();
  });

  it('Next shows the next chapter, then pushes its ?chapter= URL once and announces it once', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const { link } = await open('CHILDHOOD');
    await click(link(/Next · Chapter 2/));
    expect(chapterTitle()).toHaveTextContent('Family');
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(null, '', '/my-story/book?chapter=FAMILY');
    // Announced once, in the live region.
    expect(screen.getAllByRole('status').filter((s) => s.textContent === 'Chapter 2: Family')).toHaveLength(1);
    expect(link(/Previous · Chapter 1/)).toHaveAttribute('href', '/my-story/book?chapter=CHILDHOOD');
    expect(screen.getAllByRole('link', { current: 'page' })[0]).toHaveTextContent('Family');
    push.mockRestore();
  });

  it('never turns back while the router has not yet reported the pushed URL, and pushes nothing for it', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const view = await open('CHILDHOOD');
    await click(view.link(/Next · Chapter 2/));
    // The router still reports the old URL for a moment: no turn back.
    await view.urlChanged();
    expect(chapterTitle()).toHaveTextContent('Family');
    // Then it reports the pushed one: nothing more happens.
    at('FAMILY');
    await view.urlChanged();
    expect(chapterTitle()).toHaveTextContent('Family');
    expect(push).toHaveBeenCalledTimes(1);
    push.mockRestore();
  });

  it('Back/Forward and contents links: the reader follows the URL without pushing another entry', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const view = await open('TRAVEL');
    at('CHILDHOOD');
    await view.urlChanged();
    expect(chapterTitle()).toHaveTextContent('Childhood');
    expect(screen.getAllByRole('status').filter((s) => s.textContent === 'Chapter 1: Childhood')).toHaveLength(1);
    at('more');
    await view.urlChanged();
    expect(chapterTitle()).toHaveTextContent('More of your story');
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it('first and last chapters disable Previous / Next and never wrap around', async () => {
    const first = await open('CHILDHOOD');
    expect(within(first.pager()).queryByRole('link', { name: /Previous/ })).not.toBeInTheDocument();
    expect(within(first.pager()).getByText('This is the first chapter').parentElement).toHaveAttribute('aria-disabled', 'true');
    first.unmount();
    const last = await open('more');
    expect(within(last.pager()).queryByRole('link', { name: /Next/ })).not.toBeInTheDocument();
    expect(within(last.pager()).getByText('This is the last chapter').parentElement).toHaveAttribute('aria-disabled', 'true');
  });

  it('a turn in progress ignores more clicks; the copy of the outgoing page is inert, hidden and without ids', async () => {
    const motion = controlledAnimations();
    const push = vi.spyOn(window.history, 'pushState');
    const { link } = await open('CHILDHOOD');
    fireEvent.click(link(/Next · Chapter 2/));
    expect(motion.animate).toHaveBeenCalled();
    // Mid-turn: the controls say so and do nothing.
    expect(link(/Next · Chapter 3/)).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(link(/Next · Chapter 3/));
    fireEvent.click(link(/Previous · Chapter 1/));
    expect(chapterTitle()).toHaveTextContent('Family');
    expect(push).not.toHaveBeenCalled();
    // One real chapter heading for assistive technology; the turning copy is hidden.
    expect(screen.queryAllByRole('heading', { level: 2, name: 'Childhood' })).toHaveLength(0);
    const copy = document.querySelector('[aria-hidden="true"][inert]');
    expect(copy).toHaveTextContent('Childhood');
    expect(copy?.querySelector('[id]')).toBeNull();
    await motion.finish();
    expect(push).toHaveBeenCalledTimes(1);
    expect(link(/Next · Chapter 3/)).not.toHaveAttribute('aria-disabled');
    expect(copy?.childElementCount).toBe(0);
    // Controls work again.
    fireEvent.click(link(/Next · Chapter 3/));
    await motion.finish();
    expect(chapterTitle()).toHaveTextContent('Travel');
    expect(push).toHaveBeenLastCalledWith(null, '', '/my-story/book?chapter=TRAVEL');
    push.mockRestore();
  });

  it('a failed animation still lands on the chapter and restores the controls', async () => {
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      value: () => ({ finished: Promise.reject(new Error('aborted')), cancel: vi.fn() }),
      configurable: true,
      writable: true,
    });
    const push = vi.spyOn(window.history, 'pushState');
    const { link } = await open('CHILDHOOD');
    await act(async () => fireEvent.click(link(/Next · Chapter 2/)));
    expect(chapterTitle()).toHaveTextContent('Family');
    expect(push).toHaveBeenCalledWith(null, '', '/my-story/book?chapter=FAMILY');
    expect(link(/Next · Chapter 3/)).not.toHaveAttribute('aria-disabled');
    push.mockRestore();
  });

  it('reduced motion: no 3D turn and no page copy, only a short fade', async () => {
    const motion = controlledAnimations();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { link } = await open('CHILDHOOD');
    fireEvent.click(link(/Next · Chapter 2/));
    expect(motion.animate).toHaveBeenCalledTimes(1);
    expect(motion.animate.mock.calls[0]).toEqual([[{ opacity: 0.4 }, { opacity: 1 }], expect.objectContaining({ duration: 160 })]);
    expect(document.querySelector('[inert]')).toBeNull();
    await motion.finish();
    expect(chapterTitle()).toHaveTextContent('Family');
  });

  it('a contents link turns straight to that chapter, then pushes its URL; the current chapter is a no-op', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    await open('CHILDHOOD');
    const contents = screen.getByRole('navigation', { name: 'Contents' });
    await click(within(contents).getAllByRole('link', { name: /Life lessons/ })[0]);
    expect(chapterTitle()).toHaveTextContent('Life lessons');
    expect(push).toHaveBeenCalledWith(null, '', '/my-story/book?chapter=LIFE_LESSONS');
    await click(within(contents).getAllByRole('link', { name: /Life lessons/ })[0]);
    expect(push).toHaveBeenCalledTimes(1);
    push.mockRestore();
  });

  it('modified clicks stay ordinary links (new tab or window)', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const { link } = await open('CHILDHOOD');
    await click(link(/Next · Chapter 2/), { ctrlKey: true });
    expect(chapterTitle()).toHaveTextContent('Childhood');
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });
});
