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
  /** Owner-only reminder; never released, versioned or in summaries. */
  privateNote: string | null;
  status: MessageStatus;
  createdAt: string;
  updatedAt: string;
  recipients: { id: string; firstName: string; lastName: string | null; relationship: string | null }[];
  /** The current version number; 0 for a message from before version history. */
  version: number;
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
  privateNote?: string | null;
  recipientIds: string[];
  /** Create only: the new-message autosave this save replaces (it is cleared). */
  recoveryDraftKey?: string;
};

export const TEXT_CONTENT_MAX = 20_000;

export const messagesApi = {
  ...resource<Message, MessageInput>('/messages'),
  /** Every summary: the Messages page groups them all by status. */
  list: (signal?: AbortSignal) => allPages<MessageSummary>('/messages', signal),
};

// Version history: saved checkpoints of the written content (title, type,
// text). Media, recipients and schedule are not versioned.
export type VersionReason = 'CREATED' | 'EDITED' | 'RESTORED';
export type MessageVersionSummary = {
  id: string;
  version: number;
  reason: VersionReason;
  createdAt: string;
  isCurrent: boolean;
};
export type MessageVersion = MessageVersionSummary & Pick<Message, 'title' | 'contentType' | 'textContent'>;

const versionsPath = (messageId: string) => `/messages/${messageId}/versions`;

export const versionsApi = {
  /** Newest first, metadata only. */
  list: (messageId: string, signal?: AbortSignal) => allPages<MessageVersionSummary>(versionsPath(messageId), signal),
  get: (messageId: string, versionId: string, signal?: AbortSignal) =>
    apiRequest<MessageVersion>(`${versionsPath(messageId)}/${versionId}`, { signal }),
  /** DRAFT only (409 otherwise); returns the message with the restored content. */
  restore: (messageId: string, versionId: string) =>
    apiRequest<Message>(`${versionsPath(messageId)}/${versionId}/restore`, { method: 'POST' }),
};

// Every trigger the API executes (Phase 16). BIRTHDAY, ANNIVERSARY and
// ANNUAL_AFTER_DEATH repeat every year, per recipient.
export const TRIGGER_TYPES = [
  'NOW',
  'FIXED_DATE',
  'BIRTHDAY',
  'ANNIVERSARY',
  'CUSTOM_EVENT',
  'ON_DEATH',
  'AFTER_DEATH',
  'ANNUAL_AFTER_DEATH',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const RECURRING_TRIGGERS: TriggerType[] = ['BIRTHDAY', 'ANNIVERSARY', 'ANNUAL_AFTER_DEATH'];
export const AFTER_DEATH_DAYS_MAX = 36_500;
export const EVENT_LABEL_MAX = 100;

export type Schedule = {
  id: string;
  triggerType: TriggerType;
  /** UTC instant: FIXED_DATE, and CUSTOM_EVENT (derived from its local fields). */
  scheduledFor: string | null;
  afterDeathDays: number | null;
  /** IANA zone + "HH:mm": BIRTHDAY, ANNIVERSARY, CUSTOM_EVENT, ANNUAL_AFTER_DEATH. */
  timezone: string | null;
  localTime: string | null;
  annualMonth: number | null;
  annualDay: number | null;
  /** CUSTOM_EVENT local calendar date (the API sends it as midnight UTC). */
  eventDate: string | null;
  eventLabel: string | null;
  /** Recipients a repeating schedule has already been shared with. */
  releasedRecipientCount?: number;
  createdAt: string;
  updatedAt: string;
};

/** Each trigger sends its own fields; scheduledFor/afterDeathDays are always present (null when unused). */
export type ScheduleInput = {
  triggerType: TriggerType;
  /** ISO 8601 with an explicit offset, e.g. 2026-12-25T09:00:00+08:00. */
  scheduledFor: string | null;
  afterDeathDays: number | null;
  timezone?: string;
  localTime?: string;
  annualMonth?: number;
  annualDay?: number;
  /** YYYY-MM-DD */
  eventDate?: string;
  eventLabel?: string;
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
