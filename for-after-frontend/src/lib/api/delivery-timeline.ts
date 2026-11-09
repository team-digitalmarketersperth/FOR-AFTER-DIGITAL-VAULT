import { apiRequest } from './client';

// GET /users/me/delivery-timeline: read-only, derived from the scheduling
// engine's own rows. Titles and first names only, never content or contacts.
export type TriggerType =
  | 'NOW'
  | 'FIXED_DATE'
  | 'BIRTHDAY'
  | 'ANNIVERSARY'
  | 'CUSTOM_EVENT'
  | 'ON_DEATH'
  | 'AFTER_DEATH'
  | 'ANNUAL_AFTER_DEATH';

export type UpcomingDelivery = {
  key: string;
  messageId: string;
  title: string;
  triggerType: TriggerType;
  /** UTC instant; null only for NOW. */
  dueAt: string | null;
  /** The schedule's own IANA zone; null = the viewer's. */
  timezone: string | null;
  eventLabel: string | null;
  recipients: string[];
  repeatsAnnually: boolean;
};

export type ConditionalDelivery = {
  key: string;
  messageId: string;
  title: string;
  triggerType: TriggerType;
  afterDeathDays: number | null;
  recipients: string[];
};

export type RecentDelivery = { key: string; messageId: string; title: string; deliveredAt: string; recipients: string[] };

export type DeliveryTimeline = {
  upcoming: UpcomingDelivery[];
  conditional: ConditionalDelivery[];
  recent: RecentDelivery[];
};

export const deliveryTimelineApi = {
  get: (signal?: AbortSignal) => apiRequest<DeliveryTimeline>('/users/me/delivery-timeline', { signal }),
};
