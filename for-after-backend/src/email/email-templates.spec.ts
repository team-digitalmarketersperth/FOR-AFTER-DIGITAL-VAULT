import {
  changeEmail,
  deathSafety,
  emailChanged,
  messageReleased,
  recipientSignInCode,
  resetPassword,
  trustedContactInvitation,
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

describe('Trusted Contact invitation email (client copy, 2026-10-19)', () => {
  const TOKEN = 'I'.repeat(43);
  const LINK = `${APP}/trusted-contact/invitation?token=${TOKEN}`;
  const ABOUT = 'https://forafter.com.au/about/';
  const e = trustedContactInvitation(APP, TOKEN, ' Jane   Holder ', 604_800, 'Sam');
  const parts = [e.text, e.html];

  it('greets the Trusted Contact by name; "Hello," without a usable name', () => {
    expect(e.text).toContain('Dear Sam,');
    expect(e.html).toContain('Dear Sam,');
    for (const missing of [null, undefined, '', '   ']) {
      const f = trustedContactInvitation(APP, TOKEN, 'Jane Holder', 604_800, missing);
      expect(f.text).toContain('\n\nHello,\n\n');
      for (const p of [f.text, f.html]) {
        expect(p).not.toMatch(/Dear (undefined|null|\s*,)/);
      }
    }
  });

  it('uses the account holder name in the subject, intro, role explanation and closing', () => {
    expect(e.subject).toBe("You've been invited to be a Trusted Contact for Jane Holder");
    for (const p of parts) {
      expect(p).toContain('Jane Holder has invited you to be one of their Trusted Contacts on For After.');
      expect(p).toContain('Jane Holder has chosen you as someone they trust to help confirm important account events.');
      expect(p).toContain('Thank you for considering being part of Jane Holder’s circle of trusted support.');
    }
    const other = trustedContactInvitation(APP, TOKEN, 'Someone Else', 604_800, 'Sam');
    expect(other.text).toContain('Someone Else has invited you');
    expect(other.text).not.toContain('Jane Holder');
  });

  it('carries the full client-approved copy in both parts', () => {
    for (const p of parts) {
      for (const line of [
        'For After is a private platform where people can create and preserve videos, voice recordings, photos and written messages for their loved ones.',
        'What does being a Trusted Contact involve?',
        'This may include notifying For After if they pass away or helping verify that information',
        'You will not have access to their private messages or memories through this role, and you will not be responsible for managing their account.',
        'Being a Trusted Contact is entirely your choice.',
        'The For After Team',
      ]) {
        expect(p).toContain(line);
      }
    }
  });

  it('Review invitation is the only button, with the dynamic token link; fallback link in the footer', () => {
    expect(e.html.match(/border-radius:999px;background/g)).toHaveLength(1);
    expect(e.html).toContain(`href="${LINK}"`);
    expect(e.html).toContain(`>Review invitation</a>`);
    expect(e.html).toContain(`copy this link into your browser: ${LINK}`);
    expect(e.text).toContain(`Review invitation:\n${LINK}`);
    const other = trustedContactInvitation('http://localhost:3000', 'x'.repeat(43), 'Jane', 604_800);
    expect(other.text).toContain(`http://localhost:3000/trusted-contact/invitation?token=${'x'.repeat(43)}`);
  });

  it('Learn more about For After links to the fixed public About page in both parts', () => {
    expect(e.html).toContain(`<a href="${ABOUT}" style="color:#483a4f;text-decoration:underline;">Learn more about For After</a>`);
    expect(e.text).toContain(`Learn more about For After:\n${ABOUT}`);
    // Secondary link sits under the button.
    expect(e.html.indexOf(ABOUT)).toBeGreaterThan(e.html.indexOf('>Review invitation</a>'));
    for (const p of parts) expect(p).not.toMatch(/localhost[^\s"]*about/i);
  });

  it('keeps the 7-day expiry and the security footer', () => {
    for (const p of parts) {
      expect(p).toContain('This link expires in 7 days.');
      expect(p).toContain('nothing happens unless you accept');
      expect(p).toContain('For After will never ask for your password or a sign-in code by email or phone.');
    }
  });

  it('nothing private or hardcoded: no content, codes, sessions or test names', () => {
    for (const p of [e.subject, ...parts]) {
      expect(p).not.toMatch(/Lisa-Ann|Bridgett|Digital Perth|session|code is|@/i);
    }
    expect(e.subject).not.toContain(TOKEN);
    expect(e.html).not.toMatch(/<script|<img|<link|<style/i);
    // Exactly two links: the invitation and the About page.
    expect(e.html.match(/href="/g)).toHaveLength(2);
  });

  it('escapes names in the HTML', () => {
    const x = trustedContactInvitation(APP, TOKEN, '<b>Eve</b>', 604_800, '<i>Sam</i>');
    expect(x.html).not.toContain('<b>Eve');
    expect(x.html).not.toContain('<i>Sam');
  });
});
