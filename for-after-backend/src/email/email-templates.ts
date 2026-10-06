/**
 * The transactional emails (Step 24). Notification and access only: they
 * never carry preserved content (message text or titles, photos, audio,
 * signed URLs), reporter details or anything that reveals why For After is
 * involved. Every email has HTML (tables + inline styles, no images, scripts
 * or web fonts, so mail clients render it as written) and a plain-text part.
 */
export type RenderedEmail = { subject: string; html: string; text: string };

// Brand tokens from frontend-design-system.md.
const C = {
  ink: '#2b2230',
  muted: '#6b6271',
  accent: '#483a4f',
  accentText: '#f3ecef',
  page: '#fafbfc',
  line: '#e6e1e8',
};
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = 'Helvetica, Arial, sans-serif';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const para = (s: string) =>
  `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${C.ink};">${s}</p>`;

const button = (label: string, href: string) => `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr>
<td style="border-radius:999px;background:${C.accent};">
<a href="${escape(href)}" style="display:inline-block;padding:14px 28px;font-family:${SANS};font-size:16px;font-weight:bold;color:${C.accentText};text-decoration:none;border-radius:999px;">${escape(label)}</a>
</td></tr></table>`;

function layout(title: string, body: string, footer: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(title)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${C.line};border-radius:20px;">
<tr><td style="padding:40px 40px 8px;font-family:${SERIF};font-size:26px;color:${C.ink};">For&nbsp;After<span style="color:#b0803c;">.</span></td></tr>
<tr><td style="padding:16px 40px 24px;">
<h1 style="margin:0 0 20px;font-family:${SERIF};font-size:28px;font-weight:normal;line-height:1.25;color:${C.ink};">${escape(title)}</h1>
${body}
</td></tr>
<tr><td style="padding:20px 40px 32px;border-top:1px solid ${C.line};font-family:${SANS};font-size:13px;line-height:1.6;color:${C.muted};">${footer}</td></tr>
</table></td></tr></table>
</body></html>`;
}

const FOOTER =
  'For After will never ask for your password or a sign-in code by email or phone.';

function signInCode(
  intro: string,
  code: string,
  minutes: number,
): RenderedEmail {
  const subject = 'Your For After sign-in code';
  const expiry = `It expires in ${minutes} minutes and can only be used once.`;
  const ignore =
    "If you didn't ask for this code, you can ignore this email. No one can sign in without it.";
  const html = layout(
    'Your sign-in code',
    `${para(escape(intro))}
<p style="margin:8px 0 24px;font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:bold;letter-spacing:8px;color:${C.ink};">${code}</p>
${para(escape(expiry))}${para(escape(ignore))}`,
    escape(FOOTER),
  );
  const text = `For After\n\nYour sign-in code\n\n${intro}\n\nYour sign-in code is ${code}\n\n${expiry}\n\n${ignore}\n\n${FOOTER}\n`;
  return { subject, html, text };
}

export const recipientSignInCode = (code: string, minutes: number) =>
  signInCode(
    'Enter this code on the For After sign-in page to continue.',
    code,
    minutes,
  );

export const trustedContactSignInCode = (code: string, minutes: number) =>
  signInCode(
    'Enter this code on the For After trusted contact sign-in page to continue.',
    code,
    minutes,
  );

/**
 * To a Recipient after a release. No sender, title or content: just the way
 * in. Greets by the Recipient's own first name; a neutral greeting without one.
 */
export function messageReleased(
  appBaseUrl: string,
  firstName?: string | null,
): RenderedEmail {
  const url = `${appBaseUrl}/recipient/sign-in`;
  const name = firstName?.replace(/\s+/g, ' ').trim();
  const greeting = name ? `Hi ${name},` : 'Hello,';
  const lines = [
    greeting,
    'Something has been left for you in For After.',
    'Sign in securely with this email address to view it. We will send you a one-time code.',
  ];
  return {
    subject: 'A message is waiting for you',
    html: layout(
      'A message is waiting for you',
      `${lines.map((l) => para(escape(l))).join('')}${button('View in For After', url)}`,
      escape(`${FOOTER} You can also open ${url} in your browser.`),
    ),
    text: `For After\n\nA message is waiting for you\n\n${lines.join('\n\n')}\n\nView in For After: ${url}\n\n${FOOTER}\n`,
  };
}

/**
 * To the account holder when a death report starts the safety check. Calm and
 * factual: no reporter, no note. The link only opens the sign-in page;
 * confirming is a deliberate, signed-in action in the app.
 */
export function deathSafety(
  displayName: string,
  appBaseUrl: string,
): RenderedEmail {
  const url = `${appBaseUrl}/login`;
  const lines = [
    "We've received a report about your For After account that needs your attention.",
    "If this report is incorrect, please sign in and confirm that you're still alive. Nothing is released while the report is being reviewed.",
  ];
  const note =
    "This email doesn't change anything in your account. You'll confirm inside For After after signing in.";
  return {
    subject: 'Action needed on your For After account',
    html: layout(
      'Please check your For After account',
      `${para(`Hello ${escape(displayName)},`)}${lines.map((l) => para(escape(l))).join('')}${button('Sign in to For After', url)}${para(`<span style="color:${C.muted};font-size:14px;">${escape(note)}</span>`)}`,
      escape(`${FOOTER} You can also open ${url} in your browser.`),
    ),
    text: `For After\n\nPlease check your For After account\n\nHello ${displayName},\n\n${lines.join('\n\n')}\n\nSign in to For After: ${url}\n\n${note}\n\n${FOOTER}\n`,
  };
}

/**
 * Phase 04. A single-use link that only works for its lifetime. The token is in
 * the link (the only place it exists); no session, code or account details.
 */
function accountLink(
  title: string,
  firstName: string | null | undefined,
  lines: string[],
  label: string,
  url: string,
  note: string,
): RenderedEmail {
  const name = firstName?.replace(/\s+/g, ' ').trim();
  const greeting = name ? `Hi ${name},` : 'Hello,';
  return {
    subject: title,
    html: layout(
      title,
      `${[greeting, ...lines].map((l) => para(escape(l))).join('')}${button(label, url)}${para(`<span style="color:${C.muted};font-size:14px;">${escape(note)}</span>`)}`,
      escape(
        `${FOOTER} If the button doesn't work, copy this link into your browser: ${url}`,
      ),
    ),
    text: `For After\n\n${title}\n\n${greeting}\n\n${lines.join('\n\n')}\n\n${label}: ${url}\n\n${note}\n\n${FOOTER}\n`,
  };
}

const lifetime = (seconds: number) =>
  seconds >= 172_800
    ? `${Math.round(seconds / 86_400)} days`
    : seconds >= 7200
      ? `${Math.round(seconds / 3600)} hours`
      : `${Math.max(1, Math.round(seconds / 60))} minutes`;

export const verifyEmail = (
  appBaseUrl: string,
  token: string,
  firstName: string | null | undefined,
  expiresInSeconds: number,
) =>
  accountLink(
    'Verify your For After email',
    firstName,
    ['Please verify your email address to continue using For After.'],
    'Verify email',
    `${appBaseUrl}/verify-email?token=${encodeURIComponent(token)}`,
    `This link expires in ${lifetime(expiresInSeconds)} and can be used once. If you didn't create a For After account, you can ignore this email.`,
  );

export const resetPassword = (
  appBaseUrl: string,
  token: string,
  firstName: string | null | undefined,
  expiresInSeconds: number,
) =>
  accountLink(
    'Reset your For After password',
    firstName,
    [
      'We received a request to reset the password for your For After account.',
      'Choose a new password with the button below. Your current password keeps working until you do.',
    ],
    'Reset password',
    `${appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`,
    `This link expires in ${lifetime(expiresInSeconds)} and can be used once. If you didn't ask to reset your password, you can ignore this email; nothing will change.`,
  );

/** Phase 08: to the NEW address. The account's email changes only once this link is used. */
export const changeEmail = (
  appBaseUrl: string,
  token: string,
  firstName: string | null | undefined,
  expiresInSeconds: number,
) =>
  accountLink(
    'Verify your new For After email',
    firstName,
    [
      'You asked to change the email address on your For After account.',
      'Verify this new email address to complete the change. Until you do, nothing changes.',
    ],
    'Verify new email',
    `${appBaseUrl}/settings/verify-email-change?token=${encodeURIComponent(token)}`,
    `This link expires in ${lifetime(expiresInSeconds)} and can be used once. If you didn't ask for this, you can ignore this email.`,
  );

/**
 * Phase 08: to the OLD address after a confirmed change. No link, no token and
 * not the new address: only that it happened.
 */
export function emailChanged(
  firstName: string | null | undefined,
): RenderedEmail {
  const title = 'Your For After email address was changed';
  const name = firstName?.replace(/\s+/g, ' ').trim();
  const lines = [
    name ? `Hi ${name},` : 'Hello,',
    'The email address on your For After account was just changed, and every device was signed out. This address no longer signs in to the account.',
    "If you made this change, there's nothing more to do. If you didn't, contact For After support straight away.",
  ];
  return {
    subject: title,
    html: layout(
      title,
      lines.map((l) => para(escape(l))).join(''),
      escape(FOOTER),
    ),
    text: `For After\n\n${title}\n\n${lines.join('\n\n')}\n\n${FOOTER}\n`,
  };
}

/**
 * Phase 10: to a newly nominated Trusted Contact (email only; SMS invitations
 * are deferred). The account holder's display name and the role, nothing else:
 * no preserved content, relationship label or account holder email. The link
 * only opens the accept/decline page; it signs no one in.
 */
export const trustedContactInvitation = (
  appBaseUrl: string,
  token: string,
  accountHolderName: string,
  expiresInSeconds: number,
) => {
  const name = accountHolderName.replace(/\s+/g, ' ').trim();
  return accountLink(
    `You've been invited to be a Trusted Contact for ${name}`,
    null,
    [
      `${name} has invited you to be one of their Trusted Contacts on For After.`,
      'As a Trusted Contact, you may help confirm important account events, including letting For After know if they pass away. You will not be given access to their private messages or memories.',
    ],
    'Review invitation',
    `${appBaseUrl}/trusted-contact/invitation?token=${encodeURIComponent(token)}`,
    `This link expires in ${lifetime(expiresInSeconds)}. If you weren't expecting this, you can ignore this email; nothing happens unless you accept.`,
  );
};
