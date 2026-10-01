import type { MediaAsset } from '@/lib/api/media';
import type { ContentType } from '@/lib/api/messages';

/**
 * What still stops a draft from being scheduled, in plain words. Mirrors
 * checkComposition() in the backend (messages/message-composition.ts) for
 * early guidance only: the schedule request's 409 is the real answer.
 * Empty = ready.
 */
export function compositionIssues(
  contentType: ContentType,
  textContent: string | null,
  media: Pick<MediaAsset, 'kind' | 'status'>[],
): string[] {
  const issues: string[] = [];
  if (media.some((m) => m.status !== 'READY')) {
    issues.push('Finish or remove any upload that is not complete.');
  }
  const ready = media.filter((m) => m.status === 'READY');
  const hasText = Boolean(textContent?.trim());
  const photos = ready.some((m) => m.kind === 'PHOTO');
  const audio = ready.some((m) => m.kind === 'AUDIO');

  switch (contentType) {
    case 'TEXT':
      if (!hasText) issues.push('Write your message.');
      if (photos || audio) issues.push('Remove the photos or audio, or change the type to Mixed.');
      break;
    case 'PHOTO':
      if (!photos) issues.push('Add at least one photo.');
      if (audio) issues.push('Remove the audio, or change the type to Mixed.');
      if (hasText) issues.push('Remove the written text, or change the type to Mixed.');
      break;
    case 'AUDIO':
      if (!audio) issues.push('Add at least one audio recording.');
      if (photos) issues.push('Remove the photos, or change the type to Mixed.');
      if (hasText) issues.push('Remove the written text, or change the type to Mixed.');
      break;
    case 'MIXED':
      if ([hasText, photos, audio].filter(Boolean).length < 2) {
        issues.push('Include at least two of: written text, a photo, audio.');
      }
      break;
  }
  return issues;
}
