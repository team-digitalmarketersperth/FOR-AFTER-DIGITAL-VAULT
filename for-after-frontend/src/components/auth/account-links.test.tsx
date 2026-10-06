import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { API, json, mockFetch, renderWithClient, router } from '@/test/utils';
import {
  ForgotPasswordForm,
  ResendVerificationForm,
  ResetPasswordForm,
  VerifyEmail,
  VerifyEmailChange,
} from './account-links';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/verify-email' }));

const TOKEN = 'T'.repeat(43);
// A factory: a Response body can be read only once.
const invalid = () =>
  json(400, {
  statusCode: 400,
  message: 'This link is invalid or has expired.',
    error: 'Bad Request',
  });
const body = (fetchMock: ReturnType<typeof mockFetch>, call = 0) =>
  JSON.parse(String(fetchMock.mock.calls[call][1]?.body));

describe('VerifyEmail', () => {
  it('verifies the token from the link once and confirms it', async () => {
    const fetchMock = mockFetch(json(200, { verified: true }), json(401));
    renderWithClient(<VerifyEmail token={TOKEN} />);
    expect(await screen.findByText('Your email is verified')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/auth/verify-email`);
    expect(body(fetchMock)).toEqual({ token: TOKEN });
    expect(screen.getByRole('link', { name: 'Continue to For After' })).toHaveAttribute('href', '/dashboard');
  });

  it('an expired or used link offers a new one', async () => {
    mockFetch(invalid());
    renderWithClient(<VerifyEmail token={TOKEN} />);
    expect(await screen.findByText("This link can't be used")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send a new verification link' })).toBeInTheDocument();
  });

  it('no token: no request, straight to the resend option', () => {
    const fetchMock = mockFetch();
    renderWithClient(<VerifyEmail />);
    expect(screen.getByText("This link can't be used")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ResendVerificationForm', () => {
  it("shows the API's generic answer, then a cooldown", async () => {
    const message = 'If that account still needs verifying, we have sent a new link.';
    const fetchMock = mockFetch(json(202, { message }));
    renderWithClient(<ResendVerificationForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Send a new verification link' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(body(fetchMock)).toEqual({ email: 'ada@example.com' });
    expect(screen.getByRole('button', { name: /Send again in \d+s/ })).toBeDisabled();
  });
});

describe('ForgotPasswordForm', () => {
  it('always ends on the same confirmation, whatever the email', async () => {
    const fetchMock = mockFetch(json(202, { message: 'If an account exists…' }));
    renderWithClient(<ForgotPasswordForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'someone@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If an account exists for this email, we've sent password reset instructions/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/auth/forgot-password`);
    expect(body(fetchMock)).toEqual({ email: 'someone@example.com' });
  });

  it('rejects an invalid email without calling the API', async () => {
    const fetchMock = mockFetch();
    renderWithClient(<ForgotPasswordForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ResetPasswordForm', () => {
  const fill = async (password: string, confirm = password) => {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New password'), password);
    await user.type(screen.getByLabelText('Confirm new password'), confirm);
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
  };

  it('uses the registration rule and checks the confirmation locally', async () => {
    const fetchMock = mockFetch();
    renderWithClient(<ResetPasswordForm token={TOKEN} />);
    await fill('short');
    expect(await screen.findByText('Password must be at least 12 characters.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the token and new password only, then asks the person to sign in', async () => {
    const fetchMock = mockFetch(json(200, { success: true }));
    renderWithClient(<ResetPasswordForm token={TOKEN} />);
    await fill('a long new passphrase');
    expect(await screen.findByText('Your password has been reset')).toBeInTheDocument();
    expect(body(fetchMock)).toEqual({ token: TOKEN, newPassword: 'a long new passphrase' });
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('an invalid or expired link offers a new one', async () => {
    mockFetch(invalid());
    renderWithClient(<ResetPasswordForm token={TOKEN} />);
    await fill('a long new passphrase');
    await waitFor(() => expect(screen.getByText("This link can't be used")).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password');
  });

  it('no token: the invalid-link state, no form', () => {
    renderWithClient(<ResetPasswordForm />);
    expect(screen.getByText("This link can't be used")).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });
});

describe('VerifyEmailChange', () => {
  it('confirms once, then asks for a sign-in with the new address', async () => {
    const fetchMock = mockFetch(json(200, { changed: true }));
    renderWithClient(<VerifyEmailChange token={TOKEN} />);
    expect(await screen.findByText('Email address updated')).toBeInTheDocument();
    expect(screen.getByText(/sign in again using your new email address/)).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/auth/change-email/confirm`);
    expect(body(fetchMock)).toEqual({ token: TOKEN });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('an expired, used or replaced link changes nothing and says so', async () => {
    mockFetch(invalid());
    renderWithClient(<VerifyEmailChange token={TOKEN} />);
    expect(await screen.findByText("This link can't be used")).toBeInTheDocument();
    expect(screen.getByText(/Your email hasn't changed/)).toBeInTheDocument();
  });

  it('an address taken meanwhile is a clear conflict', async () => {
    mockFetch(json(409, { message: 'An account with this email already exists.' }));
    renderWithClient(<VerifyEmailChange token={TOKEN} />);
    expect(await screen.findByText('That address is already in use')).toBeInTheDocument();
  });

  it('no token: no request', () => {
    const fetchMock = mockFetch();
    renderWithClient(<VerifyEmailChange />);
    expect(screen.getByText("This link can't be used")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

