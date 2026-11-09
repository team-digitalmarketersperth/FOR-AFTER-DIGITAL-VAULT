import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Readiness } from '@/lib/api/readiness';
import { json, renderWithClient, routeFetch } from '@/test/utils';
import { DashboardJourney } from './journey';

const R = '/users/me/readiness';
const readiness = (over: Partial<Record<string, object>> = {}, score?: number): Readiness => {
  const steps = [
    { key: 'PEOPLE', complete: false, people: 0, ...over.PEOPLE },
    { key: 'TRUSTED_CONTACTS', complete: false, trustedContacts: 0, ready: 0, ...over.TRUSTED_CONTACTS },
    { key: 'PRESERVED', complete: false, messages: 0, memories: 0, storyAnswers: 0, ...over.PRESERVED },
    { key: 'SCHEDULING', complete: false, messages: 0, needsScheduling: 0, ...over.SCHEDULING },
    { key: 'WISHES', complete: false, wishes: 0, ...over.WISHES },
  ] as Readiness['steps'];
  const completedSteps = steps.filter((s) => s.complete).length;
  return { score: score ?? completedSteps * 20, completedSteps, totalSteps: 5, steps };
};
const card = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('article')!;
const links = () => screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);

describe('Your For After journey (dashboard)', () => {
  it('tells the six steps in order; the outcome is never a link or a setup step', async () => {
    routeFetch({ [`GET ${R}`]: json(200, readiness()) });
    renderWithClient(<DashboardJourney />);
    expect(screen.getByRole('heading', { level: 2, name: 'Your For After journey' })).toBeInTheDocument();
    await screen.findByText('0 of 5 essentials in place');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Add the people you love',
      'Choose trusted contacts',
      'Record what matters',
      'Choose when it’s shared',
      'Keep your space updated',
      'They receive it at the right time',
    ]);
    const outcome = card('They receive it at the right time');
    expect(within(outcome).queryByRole('link')).toBeNull();
    expect(within(outcome).queryByText(/Complete|To do/)).toBeNull();
    // Only the six steps are list items to assistive technology; images are decorative.
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    for (const img of document.querySelectorAll('img')) expect(img).toHaveAttribute('alt', '');
  });

  it('loading: a quiet placeholder, never a 0% that jumps', async () => {
    let finish!: (r: Response) => void;
    routeFetch({ [`GET ${R}`]: () => new Promise<Response>((r) => (finish = r)) as unknown as Response });
    renderWithClient(<DashboardJourney />);
    expect(screen.getByLabelText('Loading your progress')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    // The steps still lead somewhere while progress loads.
    expect(links()[0]).toEqual(['Manage people', '/people']);
    finish(json(200, readiness()));
    expect(await screen.findByText('0% ready')).toBeInTheDocument();
  });

  it('new account: 0%, calm wording, five next steps, no "0 messages need scheduling"', async () => {
    routeFetch({ [`GET ${R}`]: json(200, readiness()) });
    renderWithClient(<DashboardJourney />);
    expect(await screen.findByText('0% ready')).toBeInTheDocument();
    expect(screen.getByText('0 of 5 essentials in place')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getAllByText('To do')).toHaveLength(5);
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
    expect(screen.queryByText(/0 messages need/)).toBeNull();
    expect(links()).toEqual([
      ['Add someone you love', '/people'],
      ['Add a trusted contact', '/trusted-contacts'],
      ['Preserve something meaningful', '/dashboard#your-spaces'],
      ['Write your first message', '/messages/new'],
      ['Review your wishes', '/my-wishes'],
    ]);
    expect(document.body.textContent).not.toMatch(/incomplete|failed|warning|urgent|critical/i);
  });

  it('partial: the real score, real counts, complete and to-do states with text, not colour alone', async () => {
    routeFetch({
      [`GET ${R}`]: json(
        200,
        readiness({
          PEOPLE: { complete: true, people: 3 },
          TRUSTED_CONTACTS: { complete: true, trustedContacts: 2, ready: 1 },
          PRESERVED: { complete: true, messages: 4, memories: 6, storyAnswers: 0 },
          SCHEDULING: { messages: 4, needsScheduling: 2 },
        }),
      ),
    });
    renderWithClient(<DashboardJourney />);
    expect(await screen.findByText('60% ready')).toBeInTheDocument();
    // One supporting line, no repeated sentences or extra labels.
    expect(screen.queryByText(/Your space is|thoughtful step|of 5 steps/)).toBeNull();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByText('3 of 5 essentials in place')).toBeInTheDocument();
    expect(within(card('Add the people you love')).getByText('3 people added')).toBeInTheDocument();
    expect(within(card('Add the people you love')).getByText('Complete')).toBeInTheDocument();
    expect(within(card('Choose trusted contacts')).getByText('1 of 2 ready')).toBeInTheDocument();
    expect(within(card('Record what matters')).getByText('4 messages · 6 memories')).toBeInTheDocument();
    const scheduling = card('Choose when it’s shared');
    expect(within(scheduling).getByText('2 messages need scheduling')).toBeInTheDocument();
    expect(within(scheduling).getByText('To do')).toBeInTheDocument();
    expect(within(scheduling).getByRole('link')).toHaveAttribute('href', '/messages');
    expect(within(card('Keep your space updated')).getByText('No wishes recorded yet')).toBeInTheDocument();
  });

  it('100%: ready, everything shown as complete, nothing removed or locked', async () => {
    routeFetch({
      [`GET ${R}`]: json(
        200,
        readiness({
          PEOPLE: { complete: true, people: 1 },
          TRUSTED_CONTACTS: { complete: true, trustedContacts: 2, ready: 2 },
          PRESERVED: { complete: true, messages: 1 },
          SCHEDULING: { complete: true, messages: 1 },
          WISHES: { complete: true, wishes: 2 },
        }),
      ),
    });
    renderWithClient(<DashboardJourney />);
    expect(await screen.findByText('Your essentials are in place')).toBeInTheDocument();
    expect(screen.getByText(/You can return anytime to make changes/)).toBeInTheDocument();
    expect(screen.getByText('100% ready')).toBeInTheDocument();
    expect(screen.queryByText(/of 5 essentials/)).toBeNull();
    expect(screen.getAllByText('Complete')).toHaveLength(5);
    expect(screen.getByText('Your message has its timing')).toBeInTheDocument();
    expect(screen.getByText('Wishes recorded')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(5);
  });

  it('failure: "unavailable", never 0%, and the journey still works', async () => {
    routeFetch({ [`GET ${R}`]: json(500, { statusCode: 500, message: 'Internal server error' }) });
    renderWithClient(<DashboardJourney />);
    expect(await screen.findByText(/Progress is unavailable right now/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(links()[0]).toEqual(['Manage people', '/people']);
  });

  it('refetches on every return to the dashboard (changes happen on other pages)', async () => {
    let people = 0;
    const api = routeFetch({ [`GET ${R}`]: () => json(200, readiness({ PEOPLE: { complete: people > 0, people } })) });
    const { queryClient, unmount } = renderWithClient(<DashboardJourney />);
    await screen.findByText('No one added yet');
    unmount();
    people = 2;
    render(
      <QueryClientProvider client={queryClient}>
        <DashboardJourney />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('2 people added')).toBeInTheDocument();
    await waitFor(() => expect(api.called('GET', R)).toHaveLength(2));
  });

  // Trusted Contact readiness (2026-10-14): the step completes only with a READY contact.
  it.each([
    [{ complete: false, trustedContacts: 0, ready: 0 }, 'Not set up yet', 'Add a trusted contact'],
    [{ complete: false, trustedContacts: 1, ready: 0 }, 'Waiting for your contact to accept', 'Check your contacts'],
    [{ complete: false, trustedContacts: 2, ready: 0 }, 'Waiting for your contacts to accept', 'Check your contacts'],
    [{ complete: true, trustedContacts: 1, ready: 1 }, '1 contact ready', 'Manage contacts'],
    [{ complete: true, trustedContacts: 2, ready: 2 }, '2 contacts ready', 'Manage contacts'],
  ])('trusted contacts step %o', async (step, text, cta) => {
    routeFetch({ [`GET ${R}`]: json(200, readiness({ TRUSTED_CONTACTS: step })) });
    renderWithClient(<DashboardJourney />);
    await screen.findByText(/% ready/);
    const c = card('Choose trusted contacts');
    expect(within(c).getByText(text)).toBeInTheDocument();
    expect(within(c).getByRole('link', { name: cta })).toHaveAttribute('href', '/trusted-contacts');
  });
});
