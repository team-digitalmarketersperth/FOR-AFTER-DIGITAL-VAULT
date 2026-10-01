import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API, customer, json, mockFetch, renderWithClient, router } from '@/test/utils';
import { LoginForm } from './login-form';

vi.mock('next/navigation', () => ({ useRouter: () => router }));

async function fillAndSubmit(email = 'ada@example.com', password = 'correct horse battery') {
  const user = userEvent.setup();
  if (email) await user.type(screen.getByLabelText('Email'), email);
  if (password) await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return user;
}

describe('LoginForm', () => {
  beforeEach(() => renderWithClient(<LoginForm />));

  it('logs in, confirms the session with /auth/me, then opens the dashboard', async () => {
    const fetchMock = mockFetch(json(200, customer), json(200, customer));
    await fillAndSubmit();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/dashboard'));
    const [loginUrl, loginInit] = fetchMock.mock.calls[0];
    expect(loginUrl).toBe(`${API}/auth/login`);
    expect(loginInit?.credentials).toBe('include');
    expect(JSON.parse(String(loginInit?.body))).toEqual({
      email: 'ada@example.com',
      password: 'correct horse battery',
    });
    expect(fetchMock.mock.calls[1][0]).toBe(`${API}/auth/me`);
  });

  it('rejects an invalid email without calling the API', async () => {
    const fetchMock = mockFetch();
    await fillAndSubmit('not-an-email');
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a password', async () => {
    const fetchMock = mockFetch();
    await fillAndSubmit('ada@example.com', '');
    expect(await screen.findByText('Enter your password.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables the form while pending and sends only one request', async () => {
    const fetchMock = mockFetch(new Promise<Response>(() => {}));
    const user = await fillAndSubmit();
    const button = await screen.findByRole('button', { name: /Signing in/ });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the safe backend message for wrong credentials and stays put', async () => {
    const fetchMock = mockFetch(json(401, { statusCode: 401, message: 'Invalid email or password.' }));
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(router.replace).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('shows a friendly message when rate limited', async () => {
    mockFetch(json(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }));
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Please try again shortly.',
    );
  });

  it('says the API is unreachable instead of blaming the password', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't connect to For After.");
  });

  it('stops at the admin MFA challenge without opening the dashboard', async () => {
    const fetchMock = mockFetch(
      json(200, { mfaRequired: true, mfaSetupRequired: false, challengeId: 'c', expiresInSeconds: 300 }),
    );
    await fillAndSubmit();
    expect(await screen.findByText(/requires administrator sign-in/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('does not trust a 200 login when /auth/me has no session', async () => {
    mockFetch(json(200, customer), json(401, { statusCode: 401, message: 'Unauthorized' }));
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't start your session.");
    expect(router.replace).not.toHaveBeenCalled();
  });
});
