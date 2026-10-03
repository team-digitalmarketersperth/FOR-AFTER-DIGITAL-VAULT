import {
  deathSafety,
  messageReleased,
  recipientSignInCode,
  trustedContactSignInCode,
} from './email-templates.js';

const APP = 'https://app.example.com';

describe('Email templates (Step 24)', () => {
  const all = [
    recipientSignInCode('042917', 10),
    trustedContactSignInCode('042917', 10),
    messageReleased(APP),
    deathSafety('Lisa Test', APP),
  ];

  it('every email has a subject, an HTML document and a plain-text part', () => {
    for (const email of all) {
      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.html).toMatch(/^<!doctype html>/);
      expect(email.html).toContain('For&nbsp;After');
      expect(email.text).toMatch(/^For After\n/);
      // Email-safe: no scripts, images, external CSS or tracking pixels.
      expect(email.html).not.toMatch(
        /<script|<img|<link|<style|display:\s*grid/i,
      );
    }
  });

  it('subjects reveal nothing sensitive', () => {
    expect(all.map((e) => e.subject)).toEqual([
      'Your For After sign-in code',
      'Your For After sign-in code',
      'A message is waiting for you',
      'Action needed on your For After account',
    ]);
  });

  it('sign-in codes: the code as text in both parts, expiry, and "ignore if not you"', () => {
    const [recipient, tc] = all;
    for (const e of [recipient, tc]) {
      expect(e.text).toContain('Your sign-in code is 042917');
      expect(e.html).toContain('>042917</p>');
      expect(e.text).toContain('expires in 10 minutes');
      expect(e.text).toContain("If you didn't ask for this code");
      // No link: the code is typed into the page that asked for it.
      expect(e.html).not.toContain('href=');
    }
    expect(tc.text).toContain('trusted contact sign-in page');
  });

  it('message released: only a sign-in link built from APP_BASE_URL; no token in it', () => {
    const e = messageReleased(APP);
    expect(e.html).toContain(`href="${APP}/recipient/sign-in"`);
    expect(e.text).toContain(`View in For After: ${APP}/recipient/sign-in`);
    expect(e.text).not.toMatch(/token|code=|session/i);
  });

  it('death safety: calm, sign-in link only (no confirm-alive link), no reporter details', () => {
    const e = deathSafety('Lisa Test', APP);
    expect(e.html).toContain(`href="${APP}/login"`);
    expect(e.html).not.toMatch(/confirm-alive|token=/);
    expect(e.text).toContain("confirm that you're still alive");
    expect(e.text).toContain(
      'Nothing is released while the report is being reviewed.',
    );
    expect(e.text).not.toMatch(/reported by|trusted contact|died|deceased/i);
  });

  it('escapes names so they can never inject markup', () => {
    const e = deathSafety('<b onmouseover="x">Eve</b> & co', APP);
    expect(e.html).toContain(
      '&#60;b onmouseover=&#34;x&#34;&#62;Eve&#60;/b&#62; &#38; co',
    );
    expect(e.html).not.toContain('<b onmouseover');
  });
});
