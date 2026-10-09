import { ConflictException } from '@nestjs/common';
import {
  MediaAssetStatus,
  MediaKind,
  MessageContentType,
} from '../generated/prisma/client.js';

type Composition = {
  contentType: MessageContentType;
  textContent: string | null;
  // Active (non-deleted) media only.
  media: { kind: MediaKind; status: MediaAssetStatus }[];
};

const conflict = (message: string) => new ConflictException(message);

/**
 * Drafts may be incomplete; this runs before DRAFT → SCHEDULED and throws 409
 * unless the message is exactly what its contentType says. contentType is
 * never inferred or changed here, and nothing is deleted.
 */
export function checkComposition({
  contentType,
  textContent,
  media,
}: Composition): void {
  if (media.some((m) => m.status !== MediaAssetStatus.READY)) {
    throw conflict(
      'Message contains media that is not ready. Complete or delete it first.',
    );
  }
  const hasText = Boolean(textContent?.trim());
  const photos = media.filter((m) => m.kind === MediaKind.PHOTO).length;
  const audios = media.filter((m) => m.kind === MediaKind.AUDIO).length;
  const videos = media.filter((m) => m.kind === MediaKind.VIDEO).length;
  // Phase 12 product decision (2026-10-07): video is either a VIDEO message on
  // its own or one part of a MIXED message, never inside TEXT/PHOTO/AUDIO.
  const singleModality =
    contentType === MessageContentType.TEXT ||
    contentType === MessageContentType.PHOTO ||
    contentType === MessageContentType.AUDIO;
  if (videos && singleModality) {
    throw conflict(
      `${contentType} messages cannot contain video. Use VIDEO or MIXED.`,
    );
  }

  switch (contentType) {
    case MessageContentType.TEXT:
      if (!hasText) throw conflict('TEXT messages require text.');
      if (photos || audios) {
        throw conflict('TEXT messages cannot contain media.');
      }
      return;
    case MessageContentType.PHOTO:
      if (audios) throw conflict('PHOTO messages cannot contain audio.');
      if (hasText) {
        throw conflict('PHOTO messages cannot contain text. Use MIXED.');
      }
      if (!photos) {
        throw conflict('PHOTO messages require at least one ready photo.');
      }
      return;
    case MessageContentType.AUDIO:
      if (photos) throw conflict('AUDIO messages cannot contain photos.');
      if (hasText) {
        throw conflict('AUDIO messages cannot contain text. Use MIXED.');
      }
      if (!audios) {
        throw conflict('AUDIO messages require at least one ready audio file.');
      }
      return;
    case MessageContentType.VIDEO:
      if (photos || audios) {
        throw conflict(
          'VIDEO messages cannot contain photos or audio. Use MIXED.',
        );
      }
      if (hasText) {
        throw conflict('VIDEO messages cannot contain text. Use MIXED.');
      }
      if (!videos) {
        throw conflict('VIDEO messages require at least one ready video.');
      }
      return;
    case MessageContentType.MIXED:
      const parts = [hasText, photos > 0, audios > 0, videos > 0];
      if (parts.filter(Boolean).length < 2) {
        throw conflict('MIXED messages require at least two content types.');
      }
      return;
    default:
      throw conflict('This content type is not available yet.');
  }
}
