import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API, customer, json, mockFetch, renderWithClient, router } from '@/test/utils';
import { RegisterForm } from './register-form';

vi.mock('next/navigation', () => ({ useRouter: () => router }));

async function fill(password = 'a long enough phrase') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('First name'), ' Ada ');
  await user.type(screen.getByLabelText('Last name'), 'Lovelace');
  await user.type(screen.getByLabelText('Email'), 'ada@example.com');
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('RegisterForm', () => {
  beforeEach(() => renderWithClient(<RegisterForm />));

  it('shows the real backend password rule as a hint', () => {
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
      'At least 12 characters. A short phrase works well.',
    );
  });

  it('validates required fields and password length before calling the API', async () => {
    const fetchMock = mockFetch();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Enter your first name.')).toBeInTheDocument();
    expect(screen.getByText('Enter your last name.')).toBeInTheDocument();
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Password must be at least 12 characters.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends exactly the RegisterDto fields, then goes to sign-in (no auto-login)', async () => {
    const fetchMock = mockFetch(json(201, customer));
    await fill();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login?registered=1'));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/auth/register`);
    expect(JSON.parse(String(init?.body))).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'a long enough phrase',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the duplicate-email conflict message', async () => {
    mockFetch(json(409, { statusCode: 409, message: 'An account with this email already exists.' }));
    await fill();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account with this email already exists.',
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('lists backend validation messages', async () => {
    mockFetch(json(400, { statusCode: 400, message: ['email must be an email', 'password is too weak'] }));
    await fill();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('email must be an email');
    expect(alert).toHaveTextContent('password is too weak');
  });
});
