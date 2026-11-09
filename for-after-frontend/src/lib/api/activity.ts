import type { Page } from "./admin";
import { apiRequest } from "./client";

// GET /users/me/activity: the Customer's own "Recent changes", newest first.
// Types and ids only, never content.
export type ActivityType =
  | "PERSON_ADDED"
  | "PERSON_UPDATED"
  | "PERSON_REMOVED"
  | "TRUSTED_CONTACT_ADDED"
  | "TRUSTED_CONTACT_UPDATED"
  | "TRUSTED_CONTACT_REMOVED"
  | "MESSAGE_CREATED"
  | "MESSAGE_UPDATED"
  | "MESSAGE_DELETED"
  | "MESSAGE_SCHEDULED"
  | "MESSAGE_RESCHEDULED"
  | "MESSAGE_UNSCHEDULED"
  | "MEMORY_ADDED"
  | "MEMORY_UPDATED"
  | "MEMORY_DELETED"
  | "STORY_RESPONSE_ADDED"
  | "STORY_RESPONSE_UPDATED"
  | "STORY_RESPONSE_DELETED"
  | "WISH_RESPONSE_ADDED"
  | "WISH_RESPONSE_UPDATED"
  | "WISH_RESPONSE_DELETED"
  | "PROFILE_UPDATED"
  | "EMAIL_CHANGED";

export type ActivityItem = {
  id: string;
  type: ActivityType;
  createdAt: string;
  /** Id (or prompt key) of the item while it still exists; null once removed. */
  target: string | null;
};

export const activityApi = {
  list: (page: number, limit: number, signal?: AbortSignal) =>
    apiRequest<Page<ActivityItem>>(
      `/users/me/activity?page=${page}&limit=${limit}`,
      { signal },
    ),
};
