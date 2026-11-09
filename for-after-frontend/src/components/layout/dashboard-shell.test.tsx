import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FormError } from '@/components/shared/form-field';
import type { CurrentUser } from '@/lib/api/auth';
import { toApiError } from '@/lib/api/errors';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { DashboardShell } from './dashboard-shell';

const path = vi.hoisted(() => ({ current: '/support/7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11' }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => path.current }));

const user: CurrentUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'fiona.test@example.test',
  firstName: 'Fiona',
  lastName: 'Test',
  role: 'CUSTOMER',
  status: 'ACTIVE',
  emailVerifiedAt: '2026-10-31T00:00:00.000Z',
  twoFactorEnabled: false,
  createdAt: '2026-10-31T00:00:00.000Z',
};

describe('Customer shell: Help & support and logout', () => {
  it('Help & support sits in the sidebar’s lower section, active on support detail; gone from the account menu; logout unchanged', async () => {
    const { called } = routeFetch({ 'POST /auth/logout': json(200, {}) });
    renderWithClient(
      <DashboardShell user={user}>
        <p>Page</p>
      </DashboardShell>,
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const help = within(nav).getByRole('link', { name: 'Help & support' });
    expect(help).toHaveAttribute('href', '/support');
    expect(help).toHaveAttribute('aria-current', 'page'); // a /support/:id route
    // Last in the sidebar, after every main item.
    const links = within(nav).getAllByRole('link');
    expect(links.at(-1)).toBe(help);
    expect(within(nav).getByRole('link', { name: 'My Wishes' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Fiona/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText('Help & support')).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Account settings' })).toHaveAttribute('href', '/settings');
    // Logout is still in the account menu and still signs out the same way.
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(called('POST', '/auth/logout')).toHaveLength(1));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
    expect(within(nav).queryByText(/Log out|Sign out/)).not.toBeInTheDocument();
  });

  describe('billing: lapsed customers', () => {
    const billing = (over: object) => ({ enabled: true, state: 'trial_expired', enforced: true, hasAccess: false, trialEligible: false, trial: null, subscription: null, plans: [], canManageSubscription: false, ...over });
    const shell = (where: string, data: object) => {
      path.current = where;
      router.replace.mockClear();
      routeFetch({ 'GET /billing': json(200, data) });
      return renderWithClient(
        <DashboardShell user={user}>
          <p>Page content</p>
        </DashboardShell>,
      );
    };
    const settled = () => new Promise((r) => setTimeout(r, 50));

    it.each(['/dashboard', '/messages', '/messages/7d6f1d8e', '/memory-vault/abc', '/people/abc', '/my-story/book', '/my-wishes/funeral', '/settings', '/support/new'])(
      'viewing stays open with a plan notice: %s',
      async (where) => {
        shell(where, billing({}));
        expect(await screen.findByRole('heading', { name: 'Your free trial has ended' })).toBeInTheDocument();
        expect(screen.getByText('Page content')).toBeInTheDocument();
        expect(screen.getByText(/still read, download and delete/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Choose a plan' })).toHaveAttribute('href', '/settings/plan');
        expect(router.replace).not.toHaveBeenCalled(); // nobody is sent away from their own content
      },
    );

    it.each(['/messages/new', '/messages/abc/edit', '/memory-vault/new', '/memory-vault/abc/edit', '/memory-vault/abc/create-message', '/my-story/k/create-message', '/my-wishes/k/create-message', '/people/new', '/people/abc/edit', '/trusted-contacts/new', '/trusted-contacts/abc/edit'])(
      'pages for adding or changing content show a blocker instead: %s',
      async (where) => {
        shell(where, billing({ state: 'access_ended' }));
        expect(await screen.findByRole('heading', { name: 'Your plan has ended', level: 1 })).toBeInTheDocument();
        expect(screen.queryByText('Page content')).not.toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Choose a plan' })).toHaveAttribute('href', '/settings/plan');
      },
    );

    it('the plan page itself has no notice on top; a new account is offered its trial', async () => {
      const { unmount } = shell('/settings/plan', billing({}));
      await settled();
      expect(screen.getByText('Page content')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Your free trial has ended' })).not.toBeInTheDocument();
      unmount();
      shell('/dashboard', billing({ state: 'trial_available', trialEligible: true }));
      expect(await screen.findByRole('link', { name: 'Start free trial' })).toHaveAttribute('href', '/settings/plan');
    });

    it.each([
      ['with access', billing({ hasAccess: true, state: 'trial_active' })],
      ['a payment issue still has access', billing({ hasAccess: true, state: 'payment_issue' })],
      ['billing off', billing({ enabled: false, hasAccess: true, enforced: false, state: 'no_billing_record' })],
    ])('%s: nothing changes', async (_name, data) => {
      shell('/messages/new', data);
      await settled();
      expect(screen.getByText('Page content')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Choose a plan' })).not.toBeInTheDocument();
    });

    it('while the plan cannot be read, nothing is hidden: the API remains the authority', async () => {
      path.current = '/messages/new';
      routeFetch({ 'GET /billing': json(500, {}) });
      renderWithClient(
        <DashboardShell user={user}>
          <p>Page content</p>
        </DashboardShell>,
      );
      await settled();
      expect(screen.getByText('Page content')).toBeInTheDocument();
    });
  });

  it('a refused write (402) says why and links to the plan page where the action failed', () => {
    const error = toApiError(402, { statusCode: 402, message: 'Your free trial or plan has ended. Choose a plan to continue.' });
    expect(error.kind).toBe('plan_required');
    renderWithClient(<FormError error={error} />);
    expect(screen.getByText(/Your free trial or plan has ended/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a plan' })).toHaveAttribute('href', '/settings/plan');
  });
});
