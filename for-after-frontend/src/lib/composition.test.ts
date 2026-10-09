import { describe, expect, it } from 'vitest';
import { compositionIssues } from './composition';

const ready = (kind: 'PHOTO' | 'AUDIO' | 'VIDEO') => ({ kind, status: 'READY' as const });

describe('compositionIssues (mirrors the backend check)', () => {
  it('VIDEO: one or more videos only; text or other media → Mixed', () => {
    expect(compositionIssues('VIDEO', null, [ready('VIDEO')])).toEqual([]);
    expect(compositionIssues('VIDEO', null, [])).toEqual(['Add at least one video.']);
    expect(compositionIssues('VIDEO', 'Hi', [ready('VIDEO')])).toEqual([
      'Remove the written text, or change the type to Mixed.',
    ]);
  });

  it('MIXED: video counts as one of the two or more parts', () => {
    expect(compositionIssues('MIXED', 'Hi', [ready('VIDEO')])).toEqual([]);
    expect(compositionIssues('MIXED', null, [ready('PHOTO'), ready('VIDEO')])).toEqual([]);
    expect(compositionIssues('MIXED', null, [ready('VIDEO')])).toEqual([
      'Include at least two of: written text, a photo, audio, a video.',
    ]);
  });

  it('TEXT, PHOTO and AUDIO never hold video', () => {
    expect(compositionIssues('PHOTO', null, [ready('PHOTO'), ready('VIDEO')])).toEqual([
      'Remove the video, or change the type to Video or Mixed.',
    ]);
  });
});
