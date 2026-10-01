import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/query/query-client';
import { API, customer, json, mockFetch, renderWithClient, routeFetch, router } from '@/test/utils';
import { CustomerGate, GuestGate } from './auth-gates';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/dashboard',
}));

const renderCustomerGate = () =>
  renderWithClient(
    <CustomerGate>
      <p>Private content</p>
    </CustomerGate>,
  );

describe('CustomerGate', () => {
  it('shows a loader, not private content, while the session is checked', () => {
    mockFetch(new Promise<Response>(() => {}));
    renderCustomerGate();
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session');
    expect(screen.queryByText('Private content')).not.toBeInTheDocument();
  });

  it('renders the dashboard shell for a signed-in Customer', async () => {
    const fetchMock = mockFetch(json(200, customer));
    renderCustomerGate();
    expect(await screen.findByText('Private content')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('aria-current', 'page');
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/auth/me`);
  });

  it('sends a 401 to /login without rendering private content', async () => {
    mockFetch(json(401, { statusCode: 401, message: 'Unauthorized' }));
    renderCustomerGate();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Private content')).not.toBeInTheDocument();
  });

  it('treats 403 as access denied, not as signed out', async () => {
    mockFetch(json(403, { statusCode: 403, message: 'Forbidden resource' }));
    renderCustomerGate();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.getByText("You don't have permission to access this page.")).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('offers a retry when the server fails', async () => {
    mockFetch(json(500, { statusCode: 500, message: 'Internal server error' }), json(200, customer));
    renderCustomerGate();
    expect(await screen.findByText("We couldn't load your account")).toBeInTheDocument();
    expect(screen.queryByText('Internal server error')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Private content')).toBeInTheDocument();
  });

  it('does not show the Customer dashboard to an admin session', async () => {
    mockFetch(json(200, { ...customer, role: 'ADMIN' }));
    renderCustomerGate();
    expect(await screen.findByText('This area is for Customer accounts')).toBeInTheDocument();
    expect(screen.queryByText('Private content')).not.toBeInTheDocument();
  });

  it('logs out through the API, forgets cached data and returns to /login', async () => {
    // The shell also asks for the death-verification status (safety banner).
    const api = routeFetch({
      'GET /auth/me': json(200, customer),
      'GET /death-verification/me': json(200, { status: null, safeguardEndsAt: null, canConfirmAlive: false }),
      'POST /auth/logout': json(200, { success: true }),
    });
    const { queryClient } = renderCustomerGate();
    queryClient.setQueryData(['messages'], ['private message']);

    await userEvent.click(await screen.findByRole('button', { name: 'Account: Ada Lovelace' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Log out' }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
    expect(api.called('POST', '/auth/logout')[0]).toMatchObject({ credentials: 'include' });
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull();
    expect(queryClient.getQueryData(['messages'])).toBeUndefined();
    expect(screen.queryByText('Private content')).not.toBeInTheDocument();
  });
});

describe('GuestGate', () => {
  const renderGuestGate = () =>
    renderWithClient(
      <GuestGate>
        <p>Sign-in form</p>
      </GuestGate>,
    );

  it('shows the form to a signed-out visitor', async () => {
    mockFetch(json(401, { statusCode: 401, message: 'Unauthorized' }));
    renderGuestGate();
    expect(await screen.findByText('Sign-in form')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('sends a signed-in Customer to the dashboard', async () => {
    mockFetch(json(200, customer));
    renderGuestGate();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'));
  });

  it('still shows the form when the API is unreachable', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    renderGuestGate();
    expect(await screen.findByText('Sign-in form')).toBeInTheDocument();
  });
});
