import { resource } from './resource';

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
  createdAt: string;
  updatedAt: string;
};

export type TrustedContact = Omit<Recipient, 'birthday' | 'privateNote'>;

// Only DTO fields; null clears an optional field on PATCH.
export type RecipientInput = Omit<Recipient, 'id' | 'createdAt' | 'updatedAt'>;
export type TrustedContactInput = Omit<TrustedContact, 'id' | 'createdAt' | 'updatedAt'>;

export const recipientsApi = resource<Recipient, RecipientInput>('/recipients');
export const trustedContactsApi = resource<TrustedContact, TrustedContactInput>('/trusted-contacts');
