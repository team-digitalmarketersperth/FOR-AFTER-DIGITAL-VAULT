import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json } from '@/test/utils';
import { CompanionProvider, PAGES, useCompanion } from './companion';

let path = '/dashboard';
vi.mock('next/navigation', () => ({ usePathname: () => path }));

type Call = { path: string; body: Record<string, unknown> };
/** fetch stub for POST /assistant/reply: each call waits for `reply` (or an abort). */
function assistantApi() {
  const calls: Call[] = [];
  const answers: ((r: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      calls.push({ path: new URL(input).pathname, body: JSON.parse(String(init.body)) });
      return new Promise<Response>((resolve, reject) => {
        answers.push(resolve);
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }),
  );
  return { calls, reply: (r: Response) => answers.shift()!(r) };
}
const ok = (reply: string, truncated = false) => json(200, { reply, truncated });

// Stands in for My Story's editor and its "Help me write".
function Editor({ id = 'childhood.home' }: { id?: string }) {
  const { openFor } = useCompanion();
  const [text, setText] = useState('Synthetic private words.');
  return (
    <>
      <textarea aria-label="Your answer" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" onClick={() => openFor({ key: id, question: 'Where did you grow up?', read: () => text, write: setText })}>
        Help me write
      </button>
    </>
  );
}
const ui = (account = 'u1', id?: string) => (
  <CompanionProvider key={account}>
    <Editor id={id} />
  </CompanionProvider>
);
const openPanel = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Open AI companion' }));
  return screen.findByRole('dialog', { name: /For After companion/ });
};
const panel = () => screen.getByRole('dialog', { name: /For After companion/ });
const type = (text: string) => userEvent.type(within(panel()).getByRole('textbox'), text);

afterEach(() => {
  path = '/dashboard';
  vi.unstubAllGlobals();
});

describe('For After companion (shared, Customer shell)', () => {
  it('one launcher, closed on load; opening and navigating send nothing', async () => {
    const api = assistantApi();
    const { rerender } = render(ui());
    expect(screen.getAllByRole('button', { name: 'Open AI companion' })).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    const p = await openPanel();
    expect(p).toHaveTextContent('A little help, wherever you are.');
    expect(p).toHaveTextContent('Replies are written by AI, through Groq, an external service.');
    path = '/messages';
    rerender(ui());
    expect(api.calls).toHaveLength(0);
  });

  it.each([
    ['/dashboard', ['Explain this dashboard', 'Where should I start?'], []],
    ['/people/abc/edit', ['Explain recipient fields', 'How do recipients receive messages?'], []],
    ['/trusted-contacts', ['What does a trusted contact do?', 'Explain the invitation process'], []],
    ['/messages/new', [], ['Help me start a message', 'Polish my text', 'Make it shorter']],
    ['/memory-vault/x', [], ['Help describe a memory', 'Suggest a caption from details I provide']],
    ['/my-story/book', [], ['Expand my notes', 'Ask me a question', 'Polish my answer']],
    ['/my-wishes', [], ['Help me express a preference', 'Suggest a question to consider']],
    ['/settings/storage', ['Explain available settings'], []],
  ])('%s: that page’s quick answers and writing actions only', async (at, help, writing) => {
    path = at;
    render(ui());
    const p = await openPanel();
    const names = (label: string) =>
      within(p).queryByRole('region', { name: label })
        ? within(within(p).getByRole('region', { name: label })).getAllByRole('button').map((b) => b.textContent)
        : [];
    expect(names('Quick answers')).toEqual(help);
    expect(names('Writing help')).toEqual(writing);
  });

  it('quick answers are static, with links only to pages in the app', async () => {
    const api = assistantApi();
    render(ui());
    const p = await openPanel();
    await userEvent.click(within(p).getByRole('button', { name: 'Where should I start?' }));
    expect(within(p).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/people', '/messages', '/trusted-contacts']);
    const routes = new Set(PAGES.map((x) => x.prefix).concat('/settings/storage', '/settings/activity'));
    for (const l of PAGES.flatMap((x) => x.help.flatMap((h) => h.links ?? []))) expect(routes).toContain(l.href);
    expect(api.calls).toHaveLength(0);
  });

  it('Send asks the backend with only the page id and the typed text; replies are plain text', async () => {
    const api = assistantApi();
    render(ui());
    await openPanel();
    await type('Where should I start?');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    expect(within(panel()).getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(api.calls).toEqual([
      { path: '/api/v1/assistant/reply', body: { page: 'dashboard', action: 'ask', message: 'Where should I start?', history: [] } },
    ]);
    api.reply(ok('<img src=x onerror="alert(1)"> Start with People I Love.'));
    const log = await within(panel()).findByRole('log', { name: 'Conversation' });
    await within(log).findByText(/Start with People I Love/);
    expect(log.querySelector('img')).toBeNull();
    expect(within(panel()).getByRole('textbox')).toHaveValue('');

    // The next request carries this context's turns as bounded history.
    await type('And then?');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    expect(api.calls[1].body.history).toEqual([
      { role: 'user', content: 'Where should I start?' },
      { role: 'assistant', content: '<img src=x onerror="alert(1)"> Start with People I Love.' },
    ]);
  });

  it('Help me write: the answer is sent only when included; Use this draft fills that editor, saves nothing', async () => {
    path = '/my-story';
    const api = assistantApi();
    render(ui());
    await userEvent.click(screen.getByRole('button', { name: 'Help me write' }));
    const p = await screen.findByRole('dialog', { name: /For After companion/ });
    expect(p).toHaveTextContent('For: Where did you grow up?');
    expect(within(p).queryByRole('blockquote')).toBeNull();

    // Not included: only typed notes go.
    await type('red bicycle');
    await userEvent.click(within(p).getByRole('button', { name: 'Expand my notes' }));
    expect(api.calls[0].body).toEqual({ page: 'my-story', action: 'expand', message: 'red bicycle', promptKey: 'childhood.home', history: [] });
    api.reply(ok('Draft one.'));
    await within(p).findByText('Draft one.');

    await userEvent.click(within(p).getByRole('checkbox', { name: /Include the text in my answer box/ }));
    expect(within(p).getByRole('blockquote')).toHaveTextContent('Synthetic private words.');
    await userEvent.click(within(p).getByRole('button', { name: 'Polish my answer' }));
    expect(api.calls[1].body).toMatchObject({ action: 'improve', source: 'Synthetic private words.', promptKey: 'childhood.home' });
    api.reply(ok('Polished words.'));
    await within(p).findByText('Polished words.');

    const uses = within(p).getAllByRole('button', { name: 'Use this draft' });
    await userEvent.click(uses.at(-1)!);
    expect(within(p).getByRole('status')).toHaveTextContent('It isn’t saved');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByLabelText('Your answer')).toHaveValue('Polished words.');
    expect(api.calls).toHaveLength(2); // nothing saved or sent

    // The first draft was written against the old text: it never overwrites the newer one.
    await userEvent.click(screen.getByRole('button', { name: 'Help me write' }));
    await userEvent.click(within(panel()).getAllByRole('button', { name: 'Use this draft' })[0]);
    expect(within(panel()).getByRole('status')).toHaveTextContent('Your answer has changed since you asked');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByLabelText('Your answer')).toHaveValue('Polished words.');
  });

  it('a reply for an earlier page never lands, and that page’s turns are not sent again', async () => {
    path = '/my-story';
    const api = assistantApi();
    const { rerender } = render(ui());
    await userEvent.click(screen.getByRole('button', { name: 'Help me write' }));
    await userEvent.click(await within(panel()).findByRole('checkbox', { name: /Include/ }));
    await userEvent.click(within(panel()).getByRole('button', { name: 'Polish my answer' }));
    await userEvent.keyboard('{Escape}'); // closing stops the request

    path = '/memory-vault';
    rerender(ui());
    api.reply(ok('Late reply with Synthetic private words.'));
    const p = await openPanel();
    expect(p).not.toHaveTextContent('Synthetic private words.');
    expect(p).not.toHaveTextContent('Where did you grow up?');
    await type('Beach day');
    await userEvent.click(within(p).getByRole('button', { name: 'Suggest a caption from details I provide' }));
    expect(api.calls[1].body).toEqual({ page: 'memory-vault', action: 'caption', message: 'Beach day', history: [] });
  });

  it('another account (or signing out, which unmounts the shell) starts empty and drops late replies', async () => {
    const api = assistantApi();
    const { rerender } = render(ui('u1'));
    await openPanel();
    await type('Private question');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    rerender(ui('u2'));
    api.reply(ok('Late reply'));
    const p = await openPanel();
    expect(p).not.toHaveTextContent('Late reply');
    expect(within(p).getByRole('textbox')).toHaveValue('');
  });

  it.each([
    [503, 'The assistant isn’t available right now. The quick answers above still work.'],
    [429, 'The assistant is busy, or you’ve reached the hourly limit.'],
    [502, 'The assistant couldn’t reply. Please try again.'],
  ])('%i keeps the typed request and offers Try again with the same request', async (status, message) => {
    const api = assistantApi();
    render(ui());
    await openPanel();
    await type('Where should I start?');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    api.reply(json(status, { statusCode: status, message: 'raw provider text' }));
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(message);
    expect(panel()).not.toHaveTextContent('raw provider text');
    expect(within(panel()).getByRole('textbox')).toHaveValue('Where should I start?');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Try again' }));
    expect(api.calls[1].body).toEqual(api.calls[0].body);
    api.reply(ok('Second try.'));
    await within(panel()).findByText('Second try.');
    expect(within(panel()).queryByRole('alert')).toBeNull();
  });

  it('Stop cancels the request; nothing is shown', async () => {
    const api = assistantApi();
    render(ui());
    await openPanel();
    await type('Question');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    await userEvent.click(within(panel()).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(within(panel()).queryByRole('alert')).toBeNull();
    expect(api.calls).toHaveLength(1);
  });
});
