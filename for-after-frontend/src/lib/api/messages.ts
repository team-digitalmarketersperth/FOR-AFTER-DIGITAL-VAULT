import { apiRequest } from './client';
import { allPages, resource } from './resource';

// VIDEO since Phase 12: video alone (VIDEO) or as one part of MIXED.
export const CONTENT_TYPES = ['TEXT', 'PHOTO', 'AUDIO', 'VIDEO', 'MIXED'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export type MessageStatus = 'DRAFT' | 'SCHEDULED' | 'RELEASED' | 'CANCELLED';

// Mirrors MessageResponse: recipients are summaries of live People I Love.
export type Message = {
  id: string;
  title: string;
  contentType: ContentType;
  textContent: string | null;
  status: MessageStatus;
  createdAt: string;
  updatedAt: string;
  recipients: { id: string; firstName: string; lastName: string | null; relationship: string | null }[];
};

// Mirrors MessageSummary: a GET /messages item. No full text, only a short
// preview; the detail (GET /messages/:id) has everything.
export type MessageSummary = Pick<Message, 'id' | 'title' | 'contentType' | 'status' | 'updatedAt' | 'recipients'> & {
  textPreview: string | null;
};

export type MessageInput = {
  title: string;
  contentType: ContentType;
  textContent: string | null;
  recipientIds: string[];
};

export const TEXT_CONTENT_MAX = 20_000;

export const messagesApi = {
  ...resource<Message, MessageInput>('/messages'),
  /** Every summary: the Messages page groups them all by status. */
  list: (signal?: AbortSignal) => allPages<MessageSummary>('/messages', signal),
};

// Only the triggers the API executes; BIRTHDAY, NOW etc. are reserved.
export const TRIGGER_TYPES = ['FIXED_DATE', 'ON_DEATH', 'AFTER_DEATH'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const AFTER_DEATH_DAYS_MAX = 36_500;

export type Schedule = {
  id: string;
  triggerType: TriggerType;
  scheduledFor: string | null;
  afterDeathDays: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleInput = {
  triggerType: TriggerType;
  /** ISO 8601 with an explicit offset, e.g. 2026-12-25T09:00:00+08:00. */
  scheduledFor: string | null;
  afterDeathDays: number | null;
};

const schedulePath = (messageId: string) => `/messages/${messageId}/schedule`;

export const scheduleApi = {
  get: (messageId: string, signal?: AbortSignal) =>
    apiRequest<Schedule>(schedulePath(messageId), { signal }),
  /** DRAFT → SCHEDULED; 409 when the composition is not schedulable. */
  create: (messageId: string, input: ScheduleInput) =>
    apiRequest<Schedule>(schedulePath(messageId), { method: 'POST', body: input }),
  /** Only while SCHEDULED; the message stays SCHEDULED. */
  update: (messageId: string, input: ScheduleInput) =>
    apiRequest<Schedule>(schedulePath(messageId), { method: 'PATCH', body: input }),
  /** Unschedule: SCHEDULED → DRAFT. Nothing is deleted from the message. */
  remove: (messageId: string) =>
    apiRequest<void>(schedulePath(messageId), { method: 'DELETE' }),
};
