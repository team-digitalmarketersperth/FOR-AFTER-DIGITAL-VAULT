import { describe, expect, it } from 'vitest';
import { compositionIssues } from './composition';
import { checkFile } from './api/media';
import {
  formatCalendarDate,
  humanize,
  isoToLocalInputs,
  localToOffsetIso,
} from './format';

describe('dates', () => {
  it('builds an ISO timestamp with an explicit offset for the same local moment', () => {
    const iso = localToOffsetIso('2030-12-25', '09:30');
    expect(iso).toMatch(/^2030-12-25T09:30:00[+-]\d{2}:\d{2}$/);
    expect(new Date(iso).getTime()).toBe(new Date(2030, 11, 25, 9, 30).getTime());
    expect(isoToLocalInputs(iso)).toEqual({ date: '2030-12-25', time: '09:30' });
  });

  it('never shifts a calendar date (birthday) across a timezone', () => {
    expect(formatCalendarDate('1990-01-01')).toBe('1 January 1990');
    expect(formatCalendarDate('2000-02-29')).toBe('29 February 2000');
  });

  it('turns API enums into labels', () => {
    expect(humanize('FUNNY_STORIES')).toBe('Funny stories');
    expect(humanize('CHILDHOOD')).toBe('Childhood');
  });
});

describe('compositionIssues (mirrors the backend checkComposition)', () => {
  const photo = { kind: 'PHOTO', status: 'READY' } as const;
  const audio = { kind: 'AUDIO', status: 'READY' } as const;

  it('accepts exactly-matching compositions', () => {
    expect(compositionIssues('TEXT', 'Hello', [])).toEqual([]);
    expect(compositionIssues('PHOTO', null, [photo])).toEqual([]);
    expect(compositionIssues('AUDIO', '  ', [audio])).toEqual([]);
    expect(compositionIssues('MIXED', 'Hi', [photo])).toEqual([]);
    expect(compositionIssues('MIXED', null, [photo, audio])).toEqual([]);
  });

  it('explains what is missing or not allowed', () => {
    expect(compositionIssues('TEXT', '', [])).toEqual(['Write your message.']);
    expect(compositionIssues('PHOTO', null, [])).toEqual(['Add at least one photo.']);
    expect(compositionIssues('PHOTO', 'caption', [photo])).toEqual([
      'Remove the written text, or change the type to Mixed.',
    ]);
    expect(compositionIssues('MIXED', 'only text', [])).toHaveLength(1);
    expect(compositionIssues('TEXT', 'Hi', [{ kind: 'PHOTO', status: 'PENDING_UPLOAD' }])).toContain(
      'Finish or remove any upload that is not complete.',
    );
  });
});

describe('checkFile (client-side upload checks)', () => {
  it('uses the MIME type, not the file name, and the size limit', () => {
    expect(checkFile('PHOTO', { type: 'image/png', size: 10 })).toBeNull();
    expect(checkFile('PHOTO', { type: 'image/svg+xml', size: 10 })).toMatch(/JPEG, PNG or WebP/);
    expect(checkFile('PHOTO', { type: 'image/jpeg', size: 21 * 1024 * 1024 })).toMatch(/20 MB/);
    expect(checkFile('AUDIO', { type: 'audio/webm;codecs=opus', size: 10 })).toBeNull();
    expect(checkFile('AUDIO', { type: 'video/mp4', size: 10 })).toMatch(/audio file/);
    expect(checkFile('AUDIO', { type: 'audio/mpeg', size: 0 })).toBe('This file is empty.');
  });
});
