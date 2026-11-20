import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FormError } from '@/components/shared/form-field';
import { PlanLockedButton, UpgradeDialog } from '@/components/shared/plan-lock';
import { ApiError } from '@/lib/api/errors';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/people' }));

// Updated Plans Step 6 close-out: an unresolved subscription is explained and sent to support. Nothing on these
// surfaces asks the customer to buy again (that would open a second subscription).
const unresolved = () =>
  json(200, {
    enabled: true,
    state: 'plan_unresolved',
    enforced: true,
    hasAccess: false,
    trialEligible: false,
    trial: null,
    subscription: { plan: 'unknown', cancelAtPeriodEnd: false, currentPeriodEnd: '2026-12-12T02:00:00.000Z', mapping: 'unresolved' },
    plans: [],
    canManageSubscription: true,
  });
const BUY = /View plans|Choose a plan|choose a plan|purchase|subscribe/;

describe('Unresolved plan: support, never a second purchase', () => {
  it('a locked control explains it and offers Contact support, not View plans', async () => {
    routeFetch({ 'GET /billing': unresolved() });
    renderWithClient(<PlanLockedButton label="Add person" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add person' }));
    const dialog = await screen.findByRole('dialog', { name: 'We’re checking your plan' });
    expect(within(dialog).getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support/new');
    expect(within(dialog).queryByText(BUY)).not.toBeInTheDocument();
  });

  it('the page-opened dialog says the same', async () => {
    routeFetch({ 'GET /billing': unresolved() });
    renderWithClient(<UpgradeDialog open onOpenChange={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'We’re checking your plan' });
    expect(within(dialog).getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support/new');
  });

  it('a refused save (402 PLAN_UNRESOLVED) shows the server message, keeps the typing note, and links to support', () => {
    const message = 'We couldn’t match your subscription to a plan yet, so creating and editing are paused. Please contact support.';
    renderWithClient(<FormError error={new ApiError('plan_required', 402, message, [], 'PLAN_UNRESOLVED')} />);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByText('This wasn’t saved. What you typed is still here.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support/new');
    expect(screen.queryByRole('link', { name: 'View plans' })).not.toBeInTheDocument();
  });
});
