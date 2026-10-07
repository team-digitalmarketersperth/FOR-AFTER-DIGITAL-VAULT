import { apiRequest } from './client';
import { allPages, resource } from './resource';

// Mirrors RecipientResponse / TrustedContactResponse in the backend. Optional
// fields are null when unset; `birthday` is a calendar date "YYYY-MM-DD".
export type Recipient = {
  id: string;
  firstName: string;
  lastName: string | null;
  relationship: string | null;
  email: string | null;
  mobile: string | null;
  birthday: string | null;
  privateNote: string | null;
  // Phase 09: the current READY photo, or null (initials). Its short-lived
  // signed URL is fetched only when an avatar is shown.
  photoId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Phase 10: the email invitation, as the API reports it. EXPIRED = sent but
 * past its lifetime; NOT_SENT = never sent, the send failed, or the email
 * changed since; UNAVAILABLE = no email (SMS invitations are deferred).
 */
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'NOT_SENT' | 'UNAVAILABLE';

export type TrustedContact = Omit<Recipient, 'birthday' | 'privateNote' | 'photoId'> & {
  invitation: { status: InvitationStatus; sentAt: string | null };
};

/** Phase 10 product decision, mirrored from the API (its 409 stays authoritative). */
export const MAX_TRUSTED_CONTACTS = 2;

/** The API's list envelope (PageQueryDto + paginate in the backend). */
export type Page<T> = {
  items: T[];
  pagination: { page: number; limit: number; total: number; pages: number };
};
export const RECIPIENT_PAGE_SIZE = 25;

// Only DTO fields; null clears an optional field on PATCH.
export type RecipientInput = Omit<Recipient, 'id' | 'photoId' | 'createdAt' | 'updatedAt'>;
export type TrustedContactInput = Omit<TrustedContact, 'id' | 'createdAt' | 'updatedAt' | 'invitation'>;

export const recipientsApi = {
  ...resource<Recipient, RecipientInput>('/recipients'),
  /** One page of the People I Love list, newest first. */
  page: (page: number, signal?: AbortSignal) =>
    apiRequest<Page<Recipient>>(`/recipients?page=${page}&limit=${RECIPIENT_PAGE_SIZE}`, { signal }),
  /** Everyone (the message recipient picker). */
  list: (signal?: AbortSignal) => allPages<Recipient>('/recipients', signal),
};
export const trustedContactsApi = {
  ...resource<TrustedContact, TrustedContactInput>('/trusted-contacts'),
  /** Send or resend the email invitation; any earlier link stops working. */
  invite: (id: string) => apiRequest<TrustedContact>(`/trusted-contacts/${id}/invitation`, { method: 'POST' }),
};
