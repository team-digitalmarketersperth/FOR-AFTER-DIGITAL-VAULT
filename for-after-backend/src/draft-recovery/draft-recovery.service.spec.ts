import { textRevision } from './draft-recovery.service.js';

// Standard FNV-1a 32-bit vectors. The frontend's textRevision
// (src/lib/api/drafts.ts) is tested against the same values, so both sides
// always agree on an answer's base revision.
describe('textRevision', () => {
  it.each([
    ['', 't811c9dc5'],
    ['a', 'te40c292c'],
    ['foobar', 'tbf9cf968'],
  ])('%j → %s', (text, rev) => expect(textRevision(text)).toBe(rev));

  it('no text is the same as empty text', () => {
    expect(textRevision(null)).toBe(textRevision(''));
    expect(textRevision(undefined)).toBe(textRevision(''));
  });
});
