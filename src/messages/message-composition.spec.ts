import { ConflictException } from '@nestjs/common';
import { checkComposition } from './message-composition.js';

type Kind = 'PHOTO' | 'AUDIO';
type Status = 'READY' | 'PENDING_UPLOAD' | 'FAILED';
const m = (kind: Kind, status: Status = 'READY') => ({ kind, status });
const PHOTO = m('PHOTO');
const AUDIO = m('AUDIO');

const check =
  (
    contentType: 'TEXT' | 'PHOTO' | 'AUDIO' | 'MIXED' | 'VIDEO',
    textContent: string | null,
    media: { kind: Kind; status: Status }[] = [],
  ) =>
  () =>
    checkComposition({ contentType, textContent, media });

describe('checkComposition (schedule readiness)', () => {
  it.each([
    ['TEXT + text', check('TEXT', 'Happy birthday')],
    ['PHOTO + photo', check('PHOTO', null, [PHOTO])],
    ['PHOTO + photos + blank text', check('PHOTO', '   ', [PHOTO, PHOTO])],
    ['AUDIO + audio', check('AUDIO', '', [AUDIO])],
    ['MIXED text + photo', check('MIXED', 'Hi', [PHOTO])],
    ['MIXED text + audio', check('MIXED', 'Hi', [AUDIO])],
    ['MIXED photo + audio', check('MIXED', null, [PHOTO, AUDIO])],
    ['MIXED text + photo + audio', check('MIXED', 'Hi', [PHOTO, AUDIO])],
  ])('allows %s', (_, run) => {
    expect(run).not.toThrow();
  });

  it.each([
    ['TEXT blank', check('TEXT', '  \n '), 'TEXT messages require text.'],
    ['TEXT null', check('TEXT', null), 'TEXT messages require text.'],
    ['TEXT + photo', check('TEXT', 'Hi', [PHOTO]), 'cannot contain media'],
    ['TEXT + audio', check('TEXT', 'Hi', [AUDIO]), 'cannot contain media'],
    ['PHOTO without photo', check('PHOTO', null), 'at least one ready photo'],
    ['PHOTO + text', check('PHOTO', 'Hi', [PHOTO]), 'Use MIXED'],
    [
      'PHOTO + audio',
      check('PHOTO', null, [PHOTO, AUDIO]),
      'cannot contain audio',
    ],
    ['AUDIO without audio', check('AUDIO', null), 'at least one ready audio'],
    ['AUDIO + text', check('AUDIO', 'Hi', [AUDIO]), 'Use MIXED'],
    [
      'AUDIO + photo',
      check('AUDIO', null, [AUDIO, PHOTO]),
      'cannot contain photos',
    ],
    ['MIXED text only', check('MIXED', 'Hi'), 'at least two'],
    ['MIXED photo only', check('MIXED', null, [PHOTO, PHOTO]), 'at least two'],
    ['MIXED audio only', check('MIXED', '', [AUDIO]), 'at least two'],
    ['VIDEO', check('VIDEO', 'Hi'), 'not available yet'],
  ])('refuses %s with 409', (_, run, message) => {
    expect(run).toThrow(ConflictException);
    expect(run).toThrow(message);
  });

  it.each(['PENDING_UPLOAD', 'FAILED'] as const)(
    'any %s asset blocks every content type',
    (status) => {
      for (const run of [
        check('PHOTO', null, [PHOTO, m('PHOTO', status)]),
        check('MIXED', 'Hi', [PHOTO, m('AUDIO', status)]),
        check('TEXT', 'Hi', [m('PHOTO', status)]),
      ]) {
        expect(run).toThrow('not ready');
      }
    },
  );
});
