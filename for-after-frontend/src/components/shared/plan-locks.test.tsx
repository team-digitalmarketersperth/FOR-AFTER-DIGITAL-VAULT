import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Film, ImagePlus, UserPlus } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { CreateGateNotice, PaidMediaButton, PeopleCounter, TrialLockedButton, useCreateGate } from '@/components/shared/trial-cap';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/people' }));

// Updated Plans Step 7: shared lock wording, from the server's own limits (GET /billing people + planDefinitions).
// Badges name the lowest tier that includes the feature; a cap no plan raises offers no plan at all.
const DEFS = {
  FREE_TRIAL: { recipients: 1, trustedContacts: 1 },
  PREMIUM: { recipients: 10, trustedContacts: 2 },
  COMPLETE: { recipients: 50, trustedContacts: 2 },
};
const billing = (tier: 'FREE_TRIAL' | 'PREMIUM' | 'COMPLETE' | null, recipients: { used: number; limit: number | null; limitSource: string | null }, trial = false) =>
  json(200, {
    enabled: true,
    state: trial ? 'trial_active' : 'paid_active',
    enforced: true,
    hasAccess: true,
    trialEligible: false,
    trial: null,
    subscription: null,
    plans: [],
    canManageSubscription: false,
    trialCaps: trial ? { recipients: 1, trustedContacts: 1, questions: 4, memories: 1 } : { recipients: null, trustedContacts: null, questions: null, memories: null },
    features: { media: !trial, memoryLinks: !trial },
    productTier: { tier, interval: tier && tier !== 'FREE_TRIAL' ? 'monthly' : null, mapping: tier === 'FREE_TRIAL' ? 'trial' : tier ? 'mapped' : 'unmapped' },
    people: { recipients, trustedContacts: { used: trial ? 1 : 2, limit: trial ? 1 : 2, limitSource: trial ? 'trial' : 'maximum' } },
    planDefinitions: DEFS,
  });
const open = async (name: RegExp) => {
  const button = await screen.findByRole('button', { name });
  await userEvent.click(button);
  return { button, dialog: await screen.findByRole('dialog') };
};

describe('Plan-lock dialogs (Updated Plans Step 7)', () => {
  it('trial person used: "Premium" badge; the dialog says the trial allowance and Premium’s, View plans and Close; Escape returns focus', async () => {
    routeFetch({ 'GET /billing': billing('FREE_TRIAL', { used: 1, limit: 1, limitSource: 'trial' }, true) });
    renderWithClient(<TrialLockedButton kind="recipients" label="Add someone you love" icon={UserPlus} />);
    const { button, dialog } = await open(/Add someone you love\s*Premium/);
    expect(dialog).toHaveTextContent('Your free trial includes one person in People I Love');
    expect(dialog).toHaveTextContent('For After Premium includes up to 10 people.');
    expect(within(dialog).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('Premium at 10 people: "Complete" badge and Complete’s number, comparison only (View plans), never Checkout', async () => {
    const { called } = routeFetch({ 'GET /billing': billing('PREMIUM', { used: 10, limit: 10, limitSource: 'plan' }) });
    renderWithClient(<TrialLockedButton kind="recipients" label="Add someone you love" icon={UserPlus} />);
    const { dialog } = await open(/Add someone you love\s*Complete/);
    expect(dialog).toHaveTextContent('For After Premium includes up to 10 people in People I Love. For After Complete includes up to 50.');
    expect(within(dialog).getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '/settings/plan');
    expect(called('POST', '/billing/checkout')).toHaveLength(0);
  });

  it('Complete at 50 people: no badge, no higher plan promised, Close only', async () => {
    routeFetch({ 'GET /billing': billing('COMPLETE', { used: 50, limit: 50, limitSource: 'plan' }) });
    renderWithClient(<TrialLockedButton kind="recipients" label="Add someone you love" icon={UserPlus} />);
    const { button, dialog } = await open(/^Add someone you love$/);
    expect(button).not.toHaveTextContent(/Premium|Complete/);
    expect(dialog).toHaveTextContent('the most on any plan');
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('the /new page at Complete’s cap says the same, with only the way back', async () => {
    routeFetch({ 'GET /billing': billing('COMPLETE', { used: 50, limit: 50, limitSource: 'plan' }) });
    function Gate() {
      const gate = useCreateGate('recipients', 50);
      return gate === 'open' ? <p>form</p> : <CreateGateNotice gate={gate} kind="recipients" icon={UserPlus} back={{ href: '/people', label: 'Back to People I Love' }} />;
    }
    renderWithClient(<Gate />);
    expect(await screen.findByText('You’ve added the most people a plan includes')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View plans' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to People I Love' })).toBeInTheDocument();
  });

  it('a paid account under its limit is never locked; an unmapped account (no limit) never is either', async () => {
    routeFetch({ 'GET /billing': billing('PREMIUM', { used: 9, limit: 10, limitSource: 'plan' }) });
    function Gate() {
      return <p>{useCreateGate('recipients', 9)}</p>;
    }
    const { unmount } = renderWithClient(<Gate />);
    expect(await screen.findByText('open')).toBeInTheDocument();
    unmount();
    routeFetch({ 'GET /billing': billing(null, { used: 400, limit: null, limitSource: null }) });
    renderWithClient(<Gate />);
    expect(await screen.findByText('open')).toBeInTheDocument();
  });

  it('trial media: photos say "Premium", video says "Complete", each with its own explanation', async () => {
    routeFetch({ 'GET /billing': billing('FREE_TRIAL', { used: 0, limit: 1, limitSource: 'trial' }, true) });
    renderWithClient(
      <>
        <PaidMediaButton label="Add a photo" icon={ImagePlus} />
        <PaidMediaButton label="Add a video" icon={Film} video />
      </>,
    );
    const photo = await open(/Add a photo\s*Premium/);
    expect(photo.dialog).toHaveTextContent('For After Premium adds photos and voice recordings');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const video = await open(/Add a video\s*Complete/);
    expect(within(video.dialog).getByRole('heading', { name: 'Video is part of For After Complete' })).toBeInTheDocument();
  });
});

describe('People counters (Updated Plans Step 7)', () => {
  it('"3 of 10 people", "2 of 2 trusted contacts (the most on any plan)", and a plain count with no limit (never "unlimited")', async () => {
    routeFetch({ 'GET /billing': billing('PREMIUM', { used: 3, limit: 10, limitSource: 'plan' }) });
    const { unmount } = renderWithClient(
      <>
        <PeopleCounter kind="recipients" />
        <PeopleCounter kind="trustedContacts" />
      </>,
    );
    expect(await screen.findByText('3 of 10 people')).toBeInTheDocument();
    expect(screen.getByText('2 of 2 trusted contacts (the most on any plan)')).toBeInTheDocument();
    unmount();
    routeFetch({ 'GET /billing': billing(null, { used: 4, limit: null, limitSource: null }) });
    renderWithClient(<PeopleCounter kind="recipients" />);
    expect(await screen.findByText('4 people added')).toBeInTheDocument();
    expect(screen.queryByText(/unlimited/i)).not.toBeInTheDocument();
  });

  it('nothing while the plan can’t be read (no made-up zero)', async () => {
    routeFetch({ 'GET /billing': json(400, { message: 'down' }) });
    const { container } = renderWithClient(<PeopleCounter kind="recipients" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
