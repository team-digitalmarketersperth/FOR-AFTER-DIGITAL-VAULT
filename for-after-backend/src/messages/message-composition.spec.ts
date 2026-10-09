import { ConflictException } from '@nestjs/common';
import { checkComposition } from './message-composition.js';

type Kind = 'PHOTO' | 'AUDIO' | 'VIDEO';
type Status = 'READY' | 'PENDING_UPLOAD' | 'FAILED';
const m = (kind: Kind, status: Status = 'READY') => ({ kind, status });
const PHOTO = m('PHOTO');
const AUDIO = m('AUDIO');
const VIDEO = m('VIDEO');

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
    ['VIDEO + video', check('VIDEO', null, [VIDEO])],
    ['VIDEO + videos + blank text', check('VIDEO', '  ', [VIDEO, VIDEO])],
    // MIXED + VIDEO (product decision 2026-10-07): video is one MIXED part.
    ['MIXED text + video', check('MIXED', 'Hi', [VIDEO])],
    ['MIXED photo + video', check('MIXED', null, [PHOTO, VIDEO])],
    ['MIXED audio + video', check('MIXED', null, [AUDIO, VIDEO])],
    ['MIXED all four', check('MIXED', 'Hi', [PHOTO, AUDIO, VIDEO])],
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
    ['VIDEO without video', check('VIDEO', null), 'at least one ready video'],
    ['VIDEO + text', check('VIDEO', 'Hi', [VIDEO]), 'text. Use MIXED'],
    ['VIDEO + photo', check('VIDEO', null, [VIDEO, PHOTO]), 'photos or audio'],
    ['VIDEO + audio', check('VIDEO', null, [VIDEO, AUDIO]), 'photos or audio'],
    ['MIXED videos only', check('MIXED', null, [VIDEO, VIDEO]), 'at least two'],
    ['TEXT + video', check('TEXT', 'Hi', [VIDEO]), 'cannot contain video'],
    [
      'PHOTO + video',
      check('PHOTO', null, [PHOTO, VIDEO]),
      'cannot contain video',
    ],
    [
      'AUDIO + video',
      check('AUDIO', null, [AUDIO, VIDEO]),
      'cannot contain video',
    ],
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
        check('VIDEO', null, [m('VIDEO', status)]),
        check('VIDEO', null, [VIDEO, m('VIDEO', status)]),
      ]) {
        expect(run).toThrow('not ready');
      }
    },
  );
});
