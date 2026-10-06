import {
  changeEmail,
  deathSafety,
  emailChanged,
  messageReleased,
  recipientSignInCode,
  resetPassword,
  trustedContactSignInCode,
  verifyEmail,
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

  it('message released: greets by first name, neutral without one, escaped', () => {
    expect(messageReleased(APP, ' Sofia ').text).toContain(
      'A message is waiting for you\n\nHi Sofia,\n\nSomething has been left',
    );
    for (const missing of [undefined, null, '', '   ']) {
      const e = messageReleased(APP, missing);
      expect(e.text).toContain('\n\nHello,\n\n');
      expect(e.text).not.toContain('Hi ');
    }
    const e = messageReleased(APP, '<i>Eve</i>');
    expect(e.html).toContain('Hi &#60;i&#62;Eve&#60;/i&#62;,');
    expect(e.html).not.toContain('<i>Eve');
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

  it('verify email and reset password: one single-use link with the token, its lifetime, nothing else', () => {
    const TOKEN = 'T'.repeat(43);
    const verify = verifyEmail(APP, TOKEN, 'Lisa', 86_400);
    const reset = resetPassword(APP, TOKEN, null, 3_600);
    expect(verify.subject).toBe('Verify your For After email');
    expect(reset.subject).toBe('Reset your For After password');
    expect(verify.html).toContain(`href="${APP}/verify-email?token=${TOKEN}"`);
    expect(reset.html).toContain(`href="${APP}/reset-password?token=${TOKEN}"`);
    expect(verify.text).toContain('Hi Lisa,');
    expect(reset.text).toContain('Hello,');
    expect(verify.text).toContain('expires in 24 hours and can be used once');
    expect(reset.text).toContain('expires in 60 minutes and can be used once');
    for (const e of [verify, reset]) {
      expect(e.subject).not.toContain(TOKEN);
      expect(e.text).not.toMatch(/password is|session|code is/i);
    }
  });

  it('change email: link to the settings page; the old-address notice has no link or token', () => {
    const TOKEN = 'C'.repeat(43);
    const verify = changeEmail(APP, TOKEN, 'Lisa', 86_400);
    expect(verify.subject).toBe('Verify your new For After email');
    expect(verify.html).toContain(
      `href="${APP}/settings/verify-email-change?token=${TOKEN}"`,
    );
    expect(verify.text).toContain('Until you do, nothing changes.');
    const notice = emailChanged('Lisa');
    expect(notice.subject).toBe('Your For After email address was changed');
    expect(notice.text).toContain('Hi Lisa,');
    expect(notice.html).not.toContain('href=');
    expect(notice.text).not.toMatch(/token|password is|@/);
  });
});
