import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeQueryClient } from '@/lib/query/query-client';
import { json } from '@/test/utils';
import { CompanionProvider, HelpMeWrite } from './companion';

let path = '/dashboard';
vi.mock('next/navigation', () => ({ usePathname: () => path }));

type Call = { path: string; body: Record<string, unknown> };
// Updated Plans Step 5: GET /assistant/usage (an account read, never sent to the AI service) answers this; not
// recorded in `calls`, which are the AI requests only.
let usageBody: unknown = { metered: false, reason: 'billing_off' };
const usageReads: string[] = [];
// Updated Plans Step 7: the companion reads the plan's tier (GET /billing) to decide whether "View plans" fits.
let tierInForce: 'FREE_TRIAL' | 'PREMIUM' | 'COMPLETE' | null = null;
/** fetch stub for POST /assistant/reply: each call waits for `reply` (or an abort). */
function assistantApi() {
  const calls: Call[] = [];
  const requestIds: string[] = [];
  const answers: ((r: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      if ((init.method ?? 'GET') === 'GET' && new URL(input).pathname.endsWith('/billing')) {
        return Promise.resolve(json(200, { enabled: true, state: 'paid_active', hasAccess: true, productTier: { tier: tierInForce, interval: null, mapping: 'mapped' } }));
      }
      if ((init.method ?? 'GET') === 'GET' && new URL(input).pathname.endsWith('/assistant/usage')) {
        usageReads.push(input);
        return Promise.resolve(json(200, usageBody));
      }
      // The per-Send request id (Step 5) is checked on its own, so the body assertions stay exact.
      const { requestId, ...body } = JSON.parse(String(init.body)) as Record<string, unknown>;
      requestIds.push(requestId as string);
      calls.push({ path: new URL(input).pathname, body });
      return new Promise<Response>((resolve, reject) => {
        answers.push(resolve);
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }),
  );
  return { calls, requestIds, reply: (r: Response) => answers.shift()!(r) };
}
const ok = (reply: string, more: { truncated?: boolean; draft?: boolean; open?: string } = {}) =>
  json(200, { reply, truncated: false, ...more });

// Stands in for an editor field and its "Help me write" (as My Story wires it).
function Editor({ id = 'childhood.home' }: { id?: string }) {
  const [text, setText] = useState('Synthetic private words.');
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
  }, [text]);
  return (
    <>
      <textarea aria-label="Your answer" value={text} onChange={(e) => setText(e.target.value)} />
      <textarea aria-label="Private note" defaultValue="Synthetic private note." />
      <HelpMeWrite
        targetKey={id}
        question="Where did you grow up?"
        field="Your answer"
        save="Save answer"
        read={() => latest.current}
        write={setText}
      />
    </>
  );
}
// One query client per test file render tree, as the app's shell provides.
const client = makeQueryClient();
client.setDefaultOptions({ queries: { retry: false } });
const ui = (account = 'u1', id?: string) => (
  <QueryClientProvider client={client}>
    <CompanionProvider key={account}>
      <Editor id={id} />
    </CompanionProvider>
  </QueryClientProvider>
);
const openPanel = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Open AI companion' }));
  return screen.findByRole('dialog', { name: /For After AI companion/ });
};
const panel = () => screen.getByRole('dialog', { name: /For After AI companion/ });
const type = (text: string) => userEvent.type(within(panel()).getByRole('textbox'), text);

afterEach(() => {
  path = '/dashboard';
  usageBody = { metered: false, reason: 'billing_off' };
  usageReads.length = 0;
  tierInForce = null;
  client.clear();
  vi.unstubAllGlobals();
});

describe('For After companion (shared, Customer shell)', () => {
  it('one launcher, closed on load; AI companion header, privacy copy by the composer, provider named only in Privacy details; opening and navigating send nothing', async () => {
    const api = assistantApi();
    const { rerender } = render(ui());
    expect(screen.getAllByRole('button', { name: 'Open AI companion' })).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    const p = await openPanel();
    expect(within(p).getByRole('heading', { name: 'For After AI companion' })).toBeInTheDocument();
    expect(p).toHaveTextContent('A little guidance, at your pace.');
    expect(within(p).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(p).toHaveTextContent('Current section: Dashboard');
    const input = within(p).getByRole('textbox', { name: 'Message the AI companion' });
    expect(input).toHaveAccessibleDescription('AI suggestions · You choose what to share');
    expect(input).toHaveAttribute('placeholder', 'Ask a question or share a thought…');
    const details = p.querySelector('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(p).getByText('Privacy').tagName).toBe('SUMMARY');
    expect(details).toHaveTextContent('Only your messages and text you choose to include are sent to an external AI service.');
    expect(details).toHaveTextContent('Groq');
    const normal = p.cloneNode(true) as HTMLElement;
    normal.querySelector('details')!.remove();
    expect(normal.textContent).not.toMatch(/groq|llama|gpt|model/i);
    expect(p).not.toHaveTextContent('Quick answers');
    await userEvent.click(within(p).getByText('Privacy'));
    expect(details).toHaveAttribute('open');
    path = '/messages/abc/edit';
    rerender(ui());
    // The chip follows the section, never the raw path or an id.
    expect(p).toHaveTextContent('Current section: Messages');
    expect(p).not.toHaveTextContent('/messages');
    expect(p).not.toHaveTextContent('abc');
    expect(api.calls).toHaveLength(0);
  });

  it('one scroll area: the header, close button and composer stay outside it; all content is inside', async () => {
    path = '/my-story';
    render(ui());
    await userEvent.click(screen.getByRole('button', { name: 'Help me write' }));
    const p = await screen.findByRole('dialog', { name: /For After AI companion/ });
    // The Privacy text (closed by default) is bounded on its own; it is not the conversation's scroll area.
    const scrollers = [...p.querySelectorAll('.overflow-y-auto')].filter((el) => !el.closest('details'));
    // The answer preview (only when included) may scroll on its own; the panel has one main scroll area.
    expect(scrollers).toHaveLength(1);
    const middle = scrollers[0];
    expect(middle).toHaveClass('companion-scroll', 'min-h-0', 'flex-1');
    expect(p).not.toHaveClass('overflow-y-auto');
    expect(middle).not.toContainElement(within(p).getByRole('heading', { name: /For After AI companion/ }));
    expect(middle).not.toContainElement(within(p).getByRole('button', { name: 'Close' }));
    expect(middle).not.toContainElement(within(p).getByRole('textbox'));
    expect(middle).not.toContainElement(within(p).getByRole('button', { name: 'Send' }));
    for (const el of [
      within(p).getByRole('heading', { name: 'What would you like help with?' }),
      within(p).getByRole('checkbox', { name: /Include/ }),
      within(p).getByRole('region', { name: 'Writing help' }),
    ])
      expect(middle).toContainElement(el);
  });

  it.each([
    ['/dashboard', ['Where should I start?', 'Help me understand my dashboard.', 'How do I write my first message?'], []],
    ['/people/abc/edit', ['What do the details for a person mean?', 'How will the people I love receive messages?'], []],
    ['/trusted-contacts', ['What does a trusted contact do?', 'How do invitations work?'], []],
    ['/messages/new', ['How do I write my first message?', 'When will my messages be shared?'], ['Help me start a message', 'Polish my text', 'Make it shorter']],
    ['/memory-vault/x', ['What can I keep in the Memory Vault?', 'Can I link a memory to My Story?'], ['Help describe a memory', 'Suggest a caption from details I provide']],
    ['/my-story/book', ['How does My Story work?', 'How do I save my answer?'], ['Expand my notes', 'Ask me a question', 'Polish my answer']],
    ['/my-wishes', ['What is My Wishes for?', 'Is My Wishes a legal document?'], ['Help me express a preference', 'Suggest a question to consider']],
    ['/settings/storage', ['What can I change in my settings?', 'How do I free up storage?'], []],
  ])('%s: an empty state with that page’s suggested questions and writing actions', async (at, suggestions, writing) => {
    path = at;
    render(ui());
    const p = await openPanel();
    expect(within(p).getByRole('heading', { name: 'What would you like help with?' })).toBeInTheDocument();
    const buttons = (role: 'list' | 'region', name: string) =>
      within(p).queryByRole(role, { name }) ? within(within(p).getByRole(role, { name })).getAllByRole('button').map((b) => b.textContent) : [];
    expect(buttons('list', 'Suggested questions')).toEqual(suggestions);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(buttons('region', 'Writing help')).toEqual(writing);
  });

  it('a suggested question is sent like a typed one: the user turn first, one request, then the AI reply', async () => {
    const api = assistantApi();
    render(ui());
    const p = await openPanel();
    await type('my own unsent words');
    await userEvent.click(within(p).getByRole('button', { name: 'Where should I start?' }));
    expect(api.calls).toEqual([
      { path: '/api/v1/assistant/reply', body: { page: 'dashboard', action: 'ask', message: 'Where should I start?', history: [] } },
    ]);
    const log = within(p).getByRole('log', { name: 'Conversation' });
    expect(log).toHaveTextContent('Where should I start?');
    expect(within(log).getByText('Thinking…')).toBeInTheDocument();
    expect(within(p).queryByRole('list', { name: 'Suggested questions' })).toBeNull();
    expect(within(p).getByRole('textbox')).toHaveValue('my own unsent words');
    api.reply(ok('Start with People I Love.'));
    await within(log).findByText('Start with People I Love.');
    // Burgundy for the Customer, ivory for the companion; both wrap long words.
    expect(within(log).getByText('Where should I start?')).toHaveClass('bg-brand-maroon', 'text-white', 'wrap-anywhere');
    expect(within(log).getByText('Start with People I Love.')).toHaveClass('bg-brand-ivory', 'wrap-anywhere');
    expect(within(log).getByText('AI companion')).toBeInTheDocument();
    expect(within(log).queryByText('Thinking…')).toBeNull();
    expect(api.calls).toHaveLength(1);
  });

  it('typed messages take the same path; follow-ups carry earlier turns once, never the current message; replies are plain text', async () => {
    const api = assistantApi();
    render(ui());
    await openPanel();
    await type('How do I write my first message?');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    const sendButton = within(panel()).getByRole('button', { name: 'Send' });
    // Unavailable while waiting, but keeps focus (no jump when the reply lands); a second press sends nothing.
    expect(sendButton).toHaveAttribute('aria-disabled', 'true');
    expect(sendButton).toHaveFocus();
    await type('again');
    await userEvent.click(sendButton);
    await userEvent.clear(within(panel()).getByRole('textbox'));
    expect(api.calls).toEqual([
      { path: '/api/v1/assistant/reply', body: { page: 'dashboard', action: 'ask', message: 'How do I write my first message?', history: [] } },
    ]);
    api.reply(ok('<img src=x onerror="alert(1)"> Go to Messages, then Write a message.'));
    const log = await within(panel()).findByRole('log', { name: 'Conversation' });
    await within(log).findByText(/Go to Messages/);
    expect(log.querySelector('img')).toBeNull();

    await type('Can you help me start it?');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    expect(api.calls[1].body).toEqual({
      page: 'dashboard',
      action: 'ask',
      message: 'Can you help me start it?',
      history: [
        { role: 'user', content: 'How do I write my first message?' },
        { role: 'assistant', content: '<img src=x onerror="alert(1)"> Go to Messages, then Write a message.' },
      ],
    });
  });

  it('Help me write: the answer is sent only when included; Use this draft fills that editor, saves nothing', async () => {
    path = '/my-story';
    const api = assistantApi();
    render(ui());
    await userEvent.click(screen.getByRole('button', { name: 'Help me write' }));
    const p = await screen.findByRole('dialog', { name: /For After AI companion/ });
    expect(p).toHaveTextContent('For: Where did you grow up?');
    expect(within(p).queryByRole('blockquote')).toBeNull();

    // Not included: only typed notes go.
    await type('red bicycle');
    await userEvent.click(within(p).getByRole('button', { name: 'Expand my notes' }));
    expect(api.calls[0].body).toEqual({ page: 'my-story', action: 'expand', message: 'red bicycle', promptKey: 'childhood.home', history: [] });
    api.reply(ok('Draft one.', { draft: true }));
    await within(p).findByText('Draft one.');

    await userEvent.click(within(p).getByRole('checkbox', { name: /Include the text in “Your answer”/ }));
    expect(within(p).getByRole('blockquote')).toHaveTextContent('Synthetic private words.');
    await userEvent.click(within(p).getByRole('button', { name: 'Polish my answer' }));
    expect(api.calls[1].body).toMatchObject({ action: 'improve', source: 'Synthetic private words.', promptKey: 'childhood.home' });
    api.reply(ok('Polished words.', { draft: true }));
    await within(p).findByText('Polished words.');

    const uses = within(p).getAllByRole('button', { name: 'Use this draft' });
    await userEvent.click(uses.at(-1)!);
    expect(within(p).getByRole('status')).toHaveTextContent('The draft is in “Your answer”. It isn’t saved: review it, then choose Save answer.');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByLabelText('Your answer')).toHaveValue('Polished words.');
    expect(api.calls).toHaveLength(2); // nothing saved or sent
    expect(screen.getByLabelText('Private note')).toHaveValue('Synthetic private note.');
    expect(JSON.stringify(api.calls)).not.toContain('private note');

    // The first draft was written against the old text: it never overwrites the newer one.
    await userEvent.click(screen.getByRole('button', { name: 'Help me write' }));
    await userEvent.click(within(panel()).getAllByRole('button', { name: 'Use this draft' })[0]);
    expect(within(panel()).getByRole('status')).toHaveTextContent('“Your answer” has changed since you asked');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByLabelText('Your answer')).toHaveValue('Polished words.');
  });

  it('Use this draft only for replies the server marked as editor text; guidance and questions get Copy only', async () => {
    path = '/my-story';
    const api = assistantApi();
    render(ui());
    await userEvent.click(screen.getByRole('button', { name: 'Help me write' }));
    const p = await screen.findByRole('dialog', { name: /For After AI companion/ });
    await type('Can you help me start?');
    await userEvent.click(within(p).getByRole('button', { name: 'Send' }));
    api.reply(ok('What is one thing you remember about that house?'));
    await within(p).findByText(/one thing you remember/);
    expect(within(p).queryByRole('button', { name: 'Use this draft' })).toBeNull();
    expect(within(p).getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    await type('The blue door');
    await userEvent.click(within(p).getByRole('button', { name: 'Send' }));
    expect(api.calls[1].body.history).toEqual([
      { role: 'user', content: 'Can you help me start?' },
      { role: 'assistant', content: 'What is one thing you remember about that house?' },
    ]);
    api.reply(ok('I grew up behind a blue door.', { draft: true }));
    await userEvent.click(await within(p).findByRole('button', { name: 'Use this draft' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByLabelText('Your answer')).toHaveValue('I grew up behind a blue door.');
  });

  it('no editor on the page: a reply marked as a draft still gets Copy only', async () => {
    path = '/messages';
    const api = assistantApi();
    render(
      <QueryClientProvider client={client}>
        <CompanionProvider>{null}</CompanionProvider>
      </QueryClientProvider>,
    );
    const p = await openPanel();
    await type('Help me write to my daughter');
    await userEvent.click(within(p).getByRole('button', { name: 'Send' }));
    api.reply(ok('Dear Mia,', { draft: true }));
    await within(p).findByText('Dear Mia,');
    expect(within(p).queryByRole('button', { name: 'Use this draft' })).toBeNull();
  });

  it('section links: only approved sections, as plain links to our own routes, never the current page', async () => {
    const api = assistantApi();
    render(ui());
    const p = await openPanel();
    const ask = async (q: string, open: string) => {
      await type(q);
      await userEvent.click(within(p).getByRole('button', { name: 'Send' }));
      api.reply(ok(`Reply to ${q}`, { open }));
      await within(p).findByText(`Reply to ${q}`);
    };
    await ask('Who gets messages?', 'people');
    expect(within(p).getByRole('link', { name: 'Open People I Love' })).toHaveAttribute('href', '/people');
    await ask('Settings?', 'account');
    expect(within(p).getByRole('link', { name: 'Open Account settings' })).toHaveAttribute('href', '/settings');
    for (const bad of ['https://evil.example', 'javascript:alert(1)', 'admin', 'dashboard']) await ask(`Bad ${bad}`, bad);
    expect(within(p).getAllByRole('link')).toHaveLength(2);
    expect(api.calls).toHaveLength(6); // links never send or navigate on their own
  });

  it('included text: the preview is exactly what is sent; if the editor changed since, the preview updates and nothing is sent yet', async () => {
    path = '/my-story';
    const api = assistantApi();
    render(ui());
    await userEvent.click(screen.getByRole('button', { name: 'Help me write' }));
    await userEvent.click(await within(panel()).findByRole('checkbox', { name: /Include/ }));
    expect(within(panel()).getByLabelText('Text that will be included')).toHaveTextContent('Synthetic private words.');
    await userEvent.keyboard('{Escape}');
    await userEvent.type(screen.getByLabelText('Your answer'), ' And more.');
    await userEvent.click(screen.getByRole('button', { name: 'Help me write' }));
    await userEvent.click(within(panel()).getByRole('button', { name: 'Polish my answer' }));
    expect(api.calls).toHaveLength(0);
    expect(within(panel()).getByRole('status')).toHaveTextContent('Your text has changed, so the preview is updated.');
    expect(within(panel()).getByLabelText('Text that will be included')).toHaveTextContent('Synthetic private words. And more.');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Polish my answer' }));
    expect(api.calls[0].body.source).toBe('Synthetic private words. And more.');
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
    [503, 'The AI companion is unavailable right now. Please try again later.'],
    [429, 'The AI companion is busy, or you’ve reached the hourly limit.'],
    [502, 'The AI companion is temporarily unavailable. Please try again.'],
  ])('%i: a short status, never a canned answer; the question stays and Try again resends it without a second user turn', async (status, message) => {
    const api = assistantApi();
    render(ui());
    await openPanel();
    await type('Where should I start?');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    api.reply(json(status, { statusCode: status, message: 'raw provider text from groq' }));
    const alert = await within(panel()).findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.textContent).not.toMatch(/groq|\d{3}|raw provider/i);
    const log = within(panel()).getByRole('log', { name: 'Conversation' });
    expect(within(log).getAllByText('Where should I start?')).toHaveLength(1);
    expect(within(log).queryByText('AI companion')).toBeNull(); // no reply was invented
    await userEvent.click(within(panel()).getByRole('button', { name: 'Try again' }));
    expect(api.calls[1].body).toEqual(api.calls[0].body);
    api.reply(ok('Second try.'));
    await within(panel()).findByText('Second try.');
    expect(within(log).getAllByText('Where should I start?')).toHaveLength(1);
    expect(within(panel()).queryByRole('alert')).toBeNull();
  });

  it('Stop cancels the request; nothing is shown', async () => {
    const api = assistantApi();
    render(ui());
    await openPanel();
    await type('Question');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Send' }));
    await userEvent.click(within(panel()).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'false'));
    expect(within(panel()).queryByRole('alert')).toBeNull();
    expect(api.calls).toHaveLength(1);
  });
});

describe('AI allowance in the companion (Updated Plans Step 5)', () => {
  const answer = async (api: ReturnType<typeof assistantApi>, n: number, r: Response) => {
    await waitFor(() => expect(api.calls).toHaveLength(n));
    api.reply(r);
  };
  const exhausted = (body: object) => json(409, { statusCode: 409, error: 'Conflict', code: 'AI_ALLOWANCE_EXHAUSTED', message: 'used', ...body });

  it('trial: "X of 5 trial AI replies used"; each Send carries a fresh request id', async () => {
    usageBody = { metered: true, kind: 'trial', allowance: 5, used: 2, inProgress: 0, remaining: 3, periodEndsAt: '2026-11-23T00:00:00.000Z', resetsAt: null };
    const api = assistantApi();
    render(ui());
    const p = await openPanel();
    expect(await within(p).findByText('2 of 5 trial AI replies used')).toBeInTheDocument();
    await type('One?');
    await userEvent.click(within(p).getByRole('button', { name: 'Send' }));
    await answer(api, 1, ok('First.'));
    await within(p).findByText('First.');
    await type('Two?');
    await userEvent.click(within(p).getByRole('button', { name: 'Send' }));
    await answer(api, 2, ok('Second.'));
    await within(p).findByText('Second.');
    const ids = api.requestIds;
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('paid month: the count and the next reset (UTC); an exempt or unmetered account shows no line and never "unlimited"', async () => {
    usageBody = { metered: true, kind: 'month', allowance: 50, used: 12, inProgress: 0, remaining: 38, periodEndsAt: '2026-12-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z' };
    assistantApi();
    const { unmount } = render(ui());
    expect(await within(await openPanel()).findByText('12 of 50 AI replies used this month · resets 1 December')).toBeInTheDocument();
    unmount();
    usageBody = { metered: false, reason: 'unmapped_paid' };
    client.clear();
    assistantApi();
    render(ui('u2'));
    const p = await openPanel();
    await waitFor(() => expect(usageReads.length).toBeGreaterThan(0));
    expect(within(p).queryByText(/AI replies used/)).toBeNull();
    expect(within(p).queryByText(/unlimited/i)).toBeNull();
  });

  it('allowance used: a plain explanation with the reset date, no Try again, the typed text back in the box; nothing is resent', async () => {
    usageBody = { metered: true, kind: 'month', allowance: 50, used: 50, inProgress: 0, remaining: 0, periodEndsAt: '2026-12-01T00:00:00.000Z', resetsAt: '2026-12-01T00:00:00.000Z' };
    const api = assistantApi();
    render(ui());
    const p = await openPanel();
    await type('Help me please?');
    await userEvent.click(within(p).getByRole('button', { name: 'Send' }));
    await answer(api, 1, exhausted({ kind: 'month', allowance: 50, used: 50, resetsAt: '2026-12-01T00:00:00.000Z' }));
    const alert = await within(p).findByRole('alert');
    expect(alert).toHaveTextContent('You’ve used this month’s 50 AI companion replies. They reset on 1 December (UTC). You can keep writing on your own.');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(alert).not.toHaveTextContent(/busy|hourly/i);
    expect(within(p).getByRole('textbox')).toHaveValue('Help me please?');
    await new Promise((r) => setTimeout(r, 50));
    expect(api.calls).toHaveLength(1);
  });

  it('trial allowance used: says the trial’s replies are used (no reset date)', async () => {
    const api = assistantApi();
    render(ui());
    const p = await openPanel();
    await type('Hi?');
    await userEvent.click(within(p).getByRole('button', { name: 'Send' }));
    await answer(api, 1, exhausted({ kind: 'trial', allowance: 5, used: 5, resetsAt: null }));
    expect(await within(p).findByRole('alert')).toHaveTextContent('You’ve used the 5 AI companion replies included in your free trial. You can keep writing on your own.');
  });

  it('Step 7: a used allowance offers "View plans" on the trial and Premium only; Complete shows the reset alone', async () => {
    const run = async (tier: typeof tierInForce, allowance: object, account: string) => {
      tierInForce = tier;
      client.clear();
      const api = assistantApi();
      const r = render(ui(account));
      const p = await openPanel();
      await waitFor(() => expect(client.getQueryData(['billing'])).toBeDefined());
      await type('Hi?');
      await userEvent.click(within(p).getByRole('button', { name: 'Send' }));
      await answer(api, 1, exhausted(allowance));
      const alert = await within(p).findByRole('alert');
      const link = within(alert).queryByRole('link', { name: 'View plans' });
      r.unmount();
      return { link: link?.getAttribute('href') ?? null, text: alert.textContent ?? '' };
    };
    const month = { kind: 'month', used: 50, resetsAt: '2026-12-01T00:00:00.000Z' };
    expect((await run('FREE_TRIAL', { kind: 'trial', allowance: 5, used: 5, resetsAt: null }, 'a')).link).toBe('/settings/plan');
    expect((await run('PREMIUM', { ...month, allowance: 50 }, 'b')).link).toBe('/settings/plan');
    const complete = await run('COMPLETE', { ...month, allowance: 200, used: 200 }, 'c');
    expect(complete.link).toBeNull();
    expect(complete.text).toMatch(/reset on 1 December \(UTC\)/);
    expect(complete.text).not.toMatch(/Premium|Complete|upgrade/i);
  });

  it('the hourly abuse limit stays a separate message, with Try again, and keeps the typed text', async () => {
    const api = assistantApi();
    render(ui());
    const p = await openPanel();
    await type('Again?');
    await userEvent.click(within(p).getByRole('button', { name: 'Send' }));
    await answer(api, 1, json(429, { statusCode: 429, message: 'The assistant is busy. Please try again in a minute.' }));
    const alert = await within(p).findByRole('alert');
    expect(alert).toHaveTextContent('The AI companion is busy, or you’ve reached the hourly limit. Please try again later.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(within(alert).queryByRole('link', { name: 'View plans' })).toBeNull(); // throttling is not an allowance
    expect(within(p).getByRole('textbox')).toHaveValue('Again?');
  });
});
