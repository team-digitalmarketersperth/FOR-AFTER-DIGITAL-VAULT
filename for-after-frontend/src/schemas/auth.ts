import { z } from 'zod';

// Friendly early feedback only. The backend DTOs (for-after-backend/src/auth/dto)
// stay authoritative; these mirror just their obvious limits.

const email = z
  .string()
  .trim()
  .min(1, 'Enter your email address.')
  .max(254, 'Email address is too long.')
  .pipe(z.email('Enter a valid email address.'));

export const loginSchema = z.object({
  email,
  password: z
    .string()
    .min(1, 'Enter your password.')
    .max(128, 'Password must be 128 characters or fewer.'),
});

// RegisterDto: password 12–128 characters, no composition rules (NIST 800-63B).
export const PASSWORD_MIN = 12;
export const PASSWORD_HINT = `At least ${PASSWORD_MIN} characters. A short phrase works well.`;

const name = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter your ${label}.`)
    .max(100, `${label[0].toUpperCase()}${label.slice(1)} must be 100 characters or fewer.`);

export const registerSchema = z.object({
  firstName: name('first name'),
  lastName: name('last name'),
  email,
  password: z
    .string()
    .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters.`)
    .max(128, 'Password must be 128 characters or fewer.'),
});

export type LoginValues = z.infer<typeof loginSchema>;
export type RegisterValues = z.infer<typeof registerSchema>;
