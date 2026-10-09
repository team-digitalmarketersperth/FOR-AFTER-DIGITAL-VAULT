import { z } from 'zod';
import { MEMORY_CATEGORIES } from '@/lib/api/memory-vault';
import { AFTER_DEATH_DAYS_MAX, CONTENT_TYPES, TEXT_CONTENT_MAX, TRIGGER_TYPES } from '@/lib/api/messages';
import { ANSWER_MAX, type PromptArea } from '@/lib/api/prompts';

// Early, friendly feedback mirroring the backend DTO limits; the API stays
// authoritative. Form values are strings; blank optional fields become null
// so a PATCH clears them.

const text = (label: string, max: number) =>
  z.string().trim().max(max, `${label} must be ${max} characters or fewer.`);
const required = (label: string, max: number) =>
  text(label, max).min(1, `Enter ${label.toLowerCase()}.`);
const optional = (label: string, max: number) => text(label, max);

// Backend IsMobile(): basic shape only, stored as typed.
const MOBILE = /^\+?[0-9][0-9 ()-]{5,19}$/;
const email = z
  .string()
  .trim()
  .max(254, 'Email address is too long.')
  .refine((v) => !v || z.email().safeParse(v).success, 'Enter a valid email address.');
const mobile = z
  .string()
  .trim()
  .refine((v) => !v || MOBILE.test(v), 'Enter a phone number, e.g. +61 400 000 000.');

export const toNull = (value: string) => (value.trim() ? value.trim() : null);

const person = {
  firstName: required('First name', 100),
  lastName: optional('Last name', 100),
  relationship: optional('Relationship', 50),
  email,
  mobile,
};

export const recipientSchema = z.object({
  ...person,
  // <input type="date"> yields "YYYY-MM-DD", sent exactly as typed.
  birthday: z.string().refine((v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Enter a valid date.'),
  privateNote: z.string().max(2000, 'Private note must be 2,000 characters or fewer.'),
});
export type RecipientValues = z.infer<typeof recipientSchema>;

// Backend CONTACT_METHOD_REQUIRED.
export const CONTACT_METHOD_REQUIRED = 'Provide an email or a mobile (or both).';
export const trustedContactSchema = z.object(person).refine((v) => v.email.trim() || v.mobile.trim(), {
  message: CONTACT_METHOD_REQUIRED,
  path: ['email'],
});
export type TrustedContactValues = z.infer<typeof trustedContactSchema>;

// Drafts may be incomplete (scheduling checks composition), but the API needs a
// title and at least one person on every message.
export const messageSchema = z.object({
  title: required('A title', 200),
  contentType: z.enum(CONTENT_TYPES),
  textContent: z.string().max(TEXT_CONTENT_MAX, 'Your message is longer than 20,000 characters.'),
  recipientIds: z.array(z.string()).min(1, 'Choose at least one person.'),
});
export type MessageValues = z.infer<typeof messageSchema>;

// Phase 13B: a message made from a memory; the type is always chosen.
export const memoryMessageSchema = messageSchema.omit({ textContent: true }).extend({
  includeText: z.boolean(),
  mediaAssetIds: z.array(z.string()),
});
export type MemoryMessageValues = z.infer<typeof memoryMessageSchema>;

export const memorySchema = z.object({
  title: required('A title', 200),
  category: z.enum(MEMORY_CATEGORIES, { message: 'Choose a category.' }),
  textContent: z.string().max(TEXT_CONTENT_MAX, 'This is longer than 20,000 characters.'),
  tags: z.array(z.string()),
});
export type MemoryValues = z.infer<typeof memorySchema>;

export const scheduleSchema = z
  .object({
    triggerType: z.enum(TRIGGER_TYPES),
    date: z.string(),
    time: z.string(),
    afterDeathDays: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.triggerType === 'FIXED_DATE') {
      if (!v.date) ctx.addIssue({ code: 'custom', path: ['date'], message: 'Choose a date.' });
      if (!v.time) ctx.addIssue({ code: 'custom', path: ['time'], message: 'Choose a time.' });
      if (v.date && v.time) {
        const [y, m, d] = v.date.split('-').map(Number);
        const [hh, mm] = v.time.split(':').map(Number);
        if (new Date(y, m - 1, d, hh, mm) <= new Date()) {
          ctx.addIssue({ code: 'custom', path: ['date'], message: 'Choose a date and time in the future.' });
        }
      }
    }
    if (v.triggerType === 'AFTER_DEATH') {
      const days = Number(v.afterDeathDays);
      if (v.afterDeathDays.trim() === '' || !Number.isInteger(days) || days < 0 || days > AFTER_DEATH_DAYS_MAX) {
        ctx.addIssue({
          code: 'custom',
          path: ['afterDeathDays'],
          message: `Enter a whole number of days from 0 to ${AFTER_DEATH_DAYS_MAX.toLocaleString('en-AU')}.`,
        });
      }
    }
  });
export type ScheduleValues = z.infer<typeof scheduleSchema>;

// Backend AnswerText(): stored exactly as written (not trimmed). An answer
// may be files (or, in My Story, memories) only (Phase 14B / 15B), so blank
// text is sent as null and the server refuses an empty answer.
export const answerSchema = (area: PromptArea) =>
  z.object({
    textContent: z
      .string()
      .refine(
        (v) => v.length <= ANSWER_MAX[area],
        `Your answer is longer than ${ANSWER_MAX[area].toLocaleString('en-AU')} characters.`,
      ),
  });
export type AnswerValues = z.infer<ReturnType<typeof answerSchema>>;
