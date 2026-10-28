import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditMessage, NewMessage } from '@/components/messages/message-form';
import { PromptEditor } from '@/components/prompts/prompts';
import { textRevision, type Draft } from '@/lib/api/drafts';
import type { Message } from '@/lib/api/messages';
import type { Prompt } from '@/lib/api/prompts';
import { json, page, renderWithClient, routeFetch, router } from '@/test/utils';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/messages' }));

// Autosave waits 2.5 s after typing stops: fake timers, with userEvent advancing them.
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());
const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

const message = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  title: 'For Sofia',
  contentType: 'TEXT',
  textContent: 'Saved words.',
  privateNote: null,
  status: 'DRAFT',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  recipients: [{ id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter' }],
  version: 3,
  ...over,
});
const sofia = { id: 'r1', firstName: 'Sofia', lastName: null, relationship: 'Daughter', email: null, mobile: null, birthday: null };
const draft = (over: Partial<Draft> = {}): Draft => ({
  key: 'm1',
  payload: { title: 'For Sofia', contentType: 'TEXT', textContent: 'Unsaved words from before.' },
  baseRevision: '3',
  currentRevision: '3',
  conflict: false,
  updatedAt: '2026-10-14T05:42:00Z',
  ...over,
});
const stored = (body: unknown) => json(200, { ...draft(), payload: (body as { payload: unknown }).payload });
const nothing = new Response(null, { status: 200 });

const editRoutes = (extra: Record<string, Parameters<typeof routeFetch>[0][string]> = {}) => ({
  'GET /messages/m1': json(200, message()),
  'GET /recipients': json(200, page([sofia])),
  'GET /users/me/drafts/MESSAGE/m1': nothing,
  'PUT /users/me/drafts/MESSAGE/m1': stored,
  ...extra,
});

describe('Message autosave', () => {
  it('waits for a pause in typing, then sends one autosave (not the message) with its base version', async () => {
    const api = routeFetch(editRoutes());
    renderWithClient(<EditMessage id="m1" />);
    const text = await screen.findByLabelText(/^Message/);
    await user().type(text, ' More.');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await wait(2000);
    expect(api.called('PUT', '/users/me/drafts/MESSAGE/m1')).toHaveLength(0);
    await wait(600);
    await waitFor(() => expect(screen.getByText('Autosaved just now')).toBeInTheDocument());
    const puts = api.called('PUT', '/users/me/drafts/MESSAGE/m1');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual({
      payload: { title: 'For Sofia', contentType: 'TEXT', textContent: 'Saved words. More.' },
      baseRevision: '3',
    });
    expect(api.called('PATCH', '/messages/m1')).toHaveLength(0);
    await wait(120_000);
    expect(screen.getByText('Autosaved 2 min ago')).toBeInTheDocument();
  });

  it('sends nothing when the words end up as they were saved', async () => {
    const api = routeFetch(editRoutes());
    renderWithClient(<EditMessage id="m1" />);
    const text = await screen.findByLabelText(/^Message/);
    await user().type(text, 'x{Backspace}');
    await wait(5000);
    expect(api.called('PUT', '/users/me/drafts/MESSAGE/m1')).toHaveLength(0);
  });

  it('shows a failure with Retry, which tries again', async () => {
    let fail = true;
    const api = routeFetch(
      editRoutes({ 'PUT /users/me/drafts/MESSAGE/m1': (body) => (fail ? json(500, {}) : stored(body)) }),
    );
    renderWithClient(<EditMessage id="m1" />);
    await user().type(await screen.findByLabelText(/^Message/), '!');
    await wait(2600);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t keep your latest changes.'.replace('’', "'"));
    fail = false;
    await user().click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Autosaved just now')).toBeInTheDocument());
    expect(api.called('PUT', '/users/me/drafts/MESSAGE/m1')).toHaveLength(2);
  });

  it('the explicit Save sends the message and no autosave follows it', async () => {
    const api = routeFetch(editRoutes({ 'PATCH /messages/m1': json(200, message({ textContent: 'Saved words.!', version: 4 })) }));
    renderWithClient(<EditMessage id="m1" />);
    await user().type(await screen.findByLabelText(/^Message/), '!');
    await user().click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/messages/m1'));
    await wait(5000);
    expect(api.called('PUT', '/users/me/drafts/MESSAGE/m1')).toHaveLength(0);
    expect(api.called('PATCH', '/messages/m1')[0].body).not.toHaveProperty('recoveryDraftKey');
  });
});

describe('Message recovery', () => {
  it('offers unsaved changes from an earlier visit; nothing autosaves until the Customer decides; Restore fills the editor', async () => {
    const api = routeFetch(editRoutes({ 'GET /users/me/drafts/MESSAGE/m1': json(200, draft()) }));
    renderWithClient(<EditMessage id="m1" />);
    expect(await screen.findByRole('heading', { name: 'Unsaved changes found' })).toBeInTheDocument();
    expect(screen.getByText(/weren't part of your last save/)).toBeInTheDocument();
    const text = screen.getByLabelText(/^Message/);
    expect(text).toHaveValue('Saved words.');
    await user().type(text, '?');
    await wait(5000);
    expect(api.called('PUT', '/users/me/drafts/MESSAGE/m1')).toHaveLength(0);
    await user().click(screen.getByRole('button', { name: 'Restore changes' }));
    expect(text).toHaveValue('Unsaved words from before.');
    expect(screen.queryByRole('heading', { name: 'Unsaved changes found' })).not.toBeInTheDocument();
    // The restored text is what the server already holds: nothing to send.
    await wait(5000);
    expect(api.called('PUT', '/users/me/drafts/MESSAGE/m1')).toHaveLength(0);
  });

  it('Discard removes the draft and leaves the saved words', async () => {
    const api = routeFetch(
      editRoutes({
        'GET /users/me/drafts/MESSAGE/m1': json(200, draft()),
        'DELETE /users/me/drafts/MESSAGE/m1': new Response(null, { status: 204 }),
      }),
    );
    renderWithClient(<EditMessage id="m1" />);
    await user().click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Unsaved changes found' })).not.toBeInTheDocument());
    expect(api.called('DELETE', '/users/me/drafts/MESSAGE/m1')).toHaveLength(1);
    expect(screen.getByLabelText(/^Message/)).toHaveValue('Saved words.');
  });

  it('changed elsewhere since: no Restore, the text is shown to copy from, Discard stays', async () => {
    routeFetch(editRoutes({ 'GET /users/me/drafts/MESSAGE/m1': json(200, draft({ baseRevision: '2', conflict: true })) }));
    renderWithClient(<EditMessage id="m1" />);
    expect(await screen.findByText(/was saved again after they were made/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore changes' })).not.toBeInTheDocument();
    expect(screen.getByText('Unsaved words from before.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });
});

describe('New message autosave', () => {
  it('the first autosave gets a key from the server, later ones reuse it, and Save clears it', async () => {
    const api = routeFetch({
      'GET /recipients': json(200, page([sofia])),
      'GET /users/me/drafts/NEW_MESSAGE': nothing,
      'POST /users/me/drafts/NEW_MESSAGE': (body) => json(201, { ...draft({ key: 'k1', baseRevision: 'none' }), ...(body as object) }),
      'PUT /users/me/drafts/NEW_MESSAGE/k1': (body) => json(200, { ...draft({ key: 'k1' }), ...(body as object) }),
      'POST /messages': json(201, message()),
    });
    renderWithClient(<NewMessage />);
    const u = user();
    await u.type(await screen.findByLabelText('Title'), 'For you');
    await wait(2600);
    await waitFor(() => expect(api.called('POST', '/users/me/drafts/NEW_MESSAGE')).toHaveLength(1));
    await u.type(screen.getByLabelText(/^Message/), 'Hello');
    await wait(2600);
    await waitFor(() => expect(api.called('PUT', '/users/me/drafts/NEW_MESSAGE/k1')).toHaveLength(1));
    expect(api.called('PUT', '/users/me/drafts/NEW_MESSAGE/k1')[0].body).toEqual({
      payload: { title: 'For you', contentType: 'TEXT', textContent: 'Hello' },
      baseRevision: 'none',
    });
    await u.click(screen.getByRole('checkbox', { name: /Sofia/ }));
    await u.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.called('POST', '/messages')).toHaveLength(1));
    expect(api.called('POST', '/messages')[0].body).toMatchObject({ title: 'For you', recoveryDraftKey: 'k1' });
  });
});

const storyPrompt = (over: Partial<Prompt> = {}): Prompt => ({
  key: 'childhood.home',
  category: 'CHILDHOOD',
  version: 1,
  prompt: 'What was the place you grew up in like?',
  answered: false,
  response: null,
  ...over,
});

describe('My Story / My Wishes autosave', () => {
  it('My Story: autosaves unsaved text against the saved answer, and recovers it', async () => {
    const api = routeFetch({
      'GET /my-story/prompts/childhood.home': json(200, storyPrompt()),
      'GET /my-story/prompts/childhood.home/response/media': json(200, []),
      'GET /users/me/drafts/MY_STORY/childhood.home': nothing,
      'PUT /users/me/drafts/MY_STORY/childhood.home': (body) => json(200, { ...draft({ key: 'childhood.home' }), ...(body as object) }),
    });
    const { unmount } = renderWithClient(<PromptEditor area="my-story" promptKey="childhood.home" />);
    await user().type(await screen.findByLabelText('Your answer'), 'A house by the sea');
    await wait(2600);
    await waitFor(() => expect(api.called('PUT', '/users/me/drafts/MY_STORY/childhood.home')).toHaveLength(1));
    expect(api.called('PUT', '/users/me/drafts/MY_STORY/childhood.home')[0].body).toEqual({
      payload: { textContent: 'A house by the sea' },
      baseRevision: textRevision(''),
    });
    unmount();

    routeFetch({
      'GET /my-story/prompts/childhood.home': json(200, storyPrompt()),
      'GET /my-story/prompts/childhood.home/response/media': json(200, []),
      'GET /users/me/drafts/MY_STORY/childhood.home': json(
        200,
        draft({ key: 'childhood.home', payload: { textContent: 'A house by the sea' }, baseRevision: textRevision('') }),
      ),
    });
    renderWithClient(<PromptEditor area="my-story" promptKey="childhood.home" />);
    await user().click(await screen.findByRole('button', { name: 'Restore changes' }));
    expect(screen.getByLabelText('Your answer')).toHaveValue('A house by the sea');
  });

  it('My Wishes: autosaves with no notice acknowledgement', async () => {
    const wish = storyPrompt({ key: 'ceremony.style', category: 'CEREMONY', prompt: 'What kind of gathering would you like?' });
    const api = routeFetch({
      'GET /my-wishes/disclaimer': json(200, {
        version: 1,
        text: 'Notice.',
        requiresAcknowledgement: false,
        acknowledged: false,
        acknowledgedAt: null,
      }),
      'GET /my-wishes/prompts/ceremony.style': json(200, wish),
      'GET /my-wishes/prompts/ceremony.style/response/media': json(200, []),
      'GET /users/me/drafts/MY_WISHES/ceremony.style': nothing,
      'PUT /users/me/drafts/MY_WISHES/ceremony.style': (body) => json(200, { ...draft({ key: 'ceremony.style' }), ...(body as object) }),
    });
    renderWithClient(<PromptEditor area="my-wishes" promptKey="ceremony.style" />);
    await user().type(await screen.findByLabelText('Your answer'), 'Small, outdoors');
    await wait(2600);
    await waitFor(() => expect(api.called('PUT', '/users/me/drafts/MY_WISHES/ceremony.style')).toHaveLength(1));
  });
});

// Same FNV-1a vectors as the API's textRevision spec: both sides must agree.
describe('textRevision', () => {
  it.each([
    ['', 't811c9dc5'],
    ['a', 'te40c292c'],
    ['foobar', 'tbf9cf968'],
  ])('%j → %s', (text, rev) => expect(textRevision(text)).toBe(rev));
});
