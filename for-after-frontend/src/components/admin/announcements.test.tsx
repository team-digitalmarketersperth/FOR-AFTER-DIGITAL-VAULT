import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminMe } from '@/lib/api/admin';
import type { Announcement, AudienceReview, Broadcast, BroadcastReview, PilotGroup, TestSend } from '@/lib/api/announcements';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { AnnouncementSummary, BroadcastStatus } from '@/lib/api/announcements';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { AnnouncementEditor, AnnouncementList } from './announcements';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/announcements' }));

// Fictional content only; fetch is mocked, nothing is sent anywhere.
const ROOT: AdminMe = {
  id: 'r1',
  email: 'root@example.test',
  firstName: 'Rae',
  lastName: 'Root',
  role: 'SUPER_ADMIN',
  mfaEnabled: true,
  mfaVerified: true,
  mfaVerifiedAt: '2026-11-02T00:00:00.000Z',
};
const T = '2026-11-02T03:00:00.000Z';
const ID = '11111111-1111-4111-8111-111111111111';
const ref = { id: 'r1', firstName: 'Rae', lastName: 'Root', email: 'root@example.test' };
const draft = (over: Partial<Announcement> = {}): Announcement => ({
  id: ID,
  status: 'DRAFT',
  name: 'Spring update',
  subject: 'A note from For After',
  body: 'Hello.\n\nSecond paragraph.',
  ctaLabel: null,
  ctaDestination: null,
  version: 1,
  createdAt: T,
  updatedAt: T,
  createdBy: ref,
  updatedBy: ref,
  ...over,
});
const list = (items: Announcement[]) => ({ items, pagination: { page: 1, limit: 25, total: items.length, pages: items.length ? 1 : 0 } });
const preview = { from: { name: 'For After', address: 'info@example.test' }, subject: 'Unsaved', html: '<p>Rendered</p>', text: 'Rendered' };

describe('Notification centre', () => {
  it('list: columns, Draft status, creator, Edit link; no send, schedule or delivery numbers', async () => {
    routeFetch({ 'GET /admin-auth/me': json(200, ROOT), 'GET /admin/announcements': json(200, list([draft()])) });
    renderWithClient(<AnnouncementList page={1} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Notification centre' })).toBeInTheDocument();
    expect(screen.getByText('Prepare email announcements for your customers.')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Email announcement drafts' });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Draft name', 'Email subject', 'Status', 'Last updated', 'Created by', 'Actions']);
    const row = within(table).getAllByRole('row')[1]!;
    expect(within(row).getByText('Draft')).toBeInTheDocument();
    expect(within(row).getByText('Rae Root')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Edit Spring update' })).toHaveAttribute('href', `/admin/announcements/${ID}`);
    expect(screen.getByRole('link', { name: 'Create announcement' })).toHaveAttribute('href', '/admin/announcements/new');
    expect(document.body.textContent).not.toMatch(/\bsend\b|schedule|publish|delivered|opened|recipients:/i);
  });

  it('empty and error states', async () => {
    routeFetch({ 'GET /admin-auth/me': json(200, ROOT), 'GET /admin/announcements': json(200, list([])) });
    const { unmount } = renderWithClient(<AnnouncementList page={1} />);
    expect(await screen.findByText('No email announcements yet.')).toBeInTheDocument();
    expect(screen.getByText('Create a draft to prepare your first announcement.')).toBeInTheDocument();
    unmount();
    routeFetch({ 'GET /admin-auth/me': json(200, ROOT), 'GET /admin/announcements': json(500, { message: 'x' }) });
    renderWithClient(<AnnouncementList page={1} />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('an ordinary admin sees "Access denied" and no draft is requested', async () => {
    const api = routeFetch({ 'GET /admin-auth/me': json(200, { ...ROOT, role: 'ADMIN' }), 'GET /admin/announcements': json(200, list([draft()])) });
    renderWithClient(<AnnouncementList page={1} />);
    expect(await screen.findByText('The Notification centre is available to super admins only.')).toBeInTheDocument();
    expect(api.called('GET', '/admin/announcements')).toHaveLength(0);
  });
});

// ─── Wizard ────────────────────────────────────────────────────────────────

const TEST_ID = '33333333-3333-4333-8333-333333333333';
const RUN = '22222222-2222-4222-8222-222222222222';
const test = (status: TestSend['status'], announcementVersion = 1): TestSend => ({
  id: TEST_ID,
  status,
  announcementVersion,
  lastErrorCode: null,
  createdAt: T,
  acceptedAt: status === 'ACCEPTED' ? T : null,
  finishedAt: null,
});
const audience = (over: Partial<AudienceReview> = {}): AudienceReview => ({
  announcementId: ID,
  version: 1,
  audience: 'PILOT',
  purpose: 'OPTIONAL_PRODUCT_NEWS',
  checkedAt: T,
  state: 'ELIGIBILITY_NOT_CONFIRMED',
  candidates: 120,
  eligible: null,
  excluded: 20,
  exclusions: { accountUnavailable: 12, emailInvalid: 1, emailNotVerified: 3, openDeathReport: 1, suppressed: 1, noConsent: 2 },
  blockers: [{ code: 'e2e_open_decision', message: 'An open policy decision (test only).' }],
  ...over,
});
const sendReview = (over: Partial<BroadcastReview> = {}): BroadcastReview => ({
  announcementId: ID,
  version: 1,
  checkedAt: T,
  from: { name: 'For After', address: 'info@example.test' },
  subject: 'A note from For After',
  html: '<p>Saved email</p>',
  purpose: 'OPTIONAL_PRODUCT_NEWS',
  audience: 'PILOT',
  candidates: 102,
  eligible: 98,
  excluded: 4,
  exclusions: { accountUnavailable: 2, emailInvalid: 0, emailNotVerified: 2, openDeathReport: 0, suppressed: 0, noConsent: 0 },
  blockers: [],
  reviewToken: 'tok.sig',
  expiresAt: '2026-11-02T03:10:00.000Z',
  ...over,
});
const blocked = sendReview({
  eligible: null,
  reviewToken: null,
  expiresAt: null,
  blockers: [{ code: 'broadcast_disabled', message: 'Customer broadcasting is turned off on this server.' }],
});
const run = (over: Partial<Broadcast> = {}): Broadcast => ({
  id: RUN,
  announcementId: ID,
  announcementVersion: 1,
  subject: 'A note from For After',
  status: 'SENDING',
  audience: 'PILOT',
  stopping: false,
  finishReason: null,
  reviewedCount: 98,
  createdAt: T,
  preparedAt: T,
  completedAt: null,
  cancelRequestedAt: null,
  requestedBy: ref,
  cancelledBy: null,
  prepared: 98,
  audiencePrepared: true,
  counts: { QUEUED: 50, PROCESSING: 1, ACCEPTED: 40, FAILED: 1, UNKNOWN: 1, SKIPPED: 5, CANCELLED: 0 },
  reasons: { QUEUED: {}, SKIPPED: { email_changed: 5 }, FAILED: { ErrorInvalidRecipients: 1 }, UNKNOWN: { timeout: 1 } },
  lastUpdatedAt: new Date().toISOString(),
  pausedUntil: null,
  ...over,
});
const pilotGroup = (over: Partial<PilotGroup> = {}): PilotGroup => ({
  audience: 'PILOT',
  max: 10,
  members: [{ userId: 'u1', email: 'pilot.one@example.test', firstName: 'Pia', lastName: 'Pilot', status: 'pass' }],
  ...over,
});
type Route = Response | ((body: unknown) => Response | Promise<Response>);
const routes = (over: Record<string, Route> = {}) =>
  routeFetch({
    'GET /admin-auth/me': json(200, ROOT),
    [`GET /admin/announcements/${ID}`]: json(200, draft()),
    'GET /admin/announcements/test-destination': json(200, { email: 'root@example.test' }),
    'POST /admin/announcements/preview': json(200, preview),
    [`GET /admin/announcements/${ID}/audience`]: json(200, audience()),
    [`POST /admin/announcements/${ID}/broadcast-review`]: json(200, sendReview()),
    [`GET /admin/announcements/${ID}/pilot`]: json(200, pilotGroup()),
    [`GET /admin/announcements/${ID}/broadcasts/${RUN}/recipients`]: json(200, { items: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } }),
    ...(over as Record<string, Response>),
  });
const step = (name: string) => screen.findByRole('heading', { level: 2, name });
const click = async (name: string | RegExp) => userEvent.click(await screen.findByRole('button', { name }));
const toPreview = async () => {
  await step('Write your announcement');
  await click('Save & continue');
  return step('Preview your email');
};
const toAudience = async () => {
  await toPreview();
  await click('Continue to audience');
  return step('Review your audience');
};
const toSend = async () => {
  await toAudience();
  const next = await screen.findByRole('button', { name: 'Continue to review' });
  await vi.waitFor(() => expect(next).toBeEnabled());
  await userEvent.click(next);
  return step('Review before sending');
};
const sends = (api: ReturnType<typeof routes>) =>
  api.calls.filter((c) => c.method === 'POST' && (c.path.endsWith('/test-sends') || c.path.endsWith('/broadcasts')));

describe('Announcement wizard', () => {
  // The step lives in the URL (?step=…); every test starts at a clean address.
  beforeEach(() => window.history.replaceState(null, '', '/admin/announcements'));

  it('create: only the Write step, with Email channel, quiet info line, collapsed button row and Cancel · Save draft · Save & continue', async () => {
    const api = routes({ 'POST /admin/announcements': () => json(201, draft()) });
    renderWithClient(<AnnouncementEditor />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Create announcement' })).toBeInTheDocument();
    expect(screen.getByText('A thoughtful update, one step at a time.')).toBeInTheDocument();
    expect(await step('Write your announcement')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Channel' })).toHaveTextContent('Channel: Email');
    expect(screen.getByText('Saving a draft does not send an email.')).toBeInTheDocument();
    expect(screen.getByText('Only visible to administrators.')).toBeInTheDocument();
    expect(screen.queryByText('Draft')).toBeNull(); // no badge before a draft exists
    // Other steps' content is not on the page.
    for (const h of ['Preview your email', 'Review your audience', 'Review before sending']) expect(screen.queryByRole('heading', { name: h })).toBeNull();
    expect(screen.queryByRole('button', { name: /test email|refresh review|queue announcement/i })).toBeNull();
    const toggle = screen.getByRole('button', { name: /Add a button/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Button label', { selector: 'input' })).not.toBeVisible();
    expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', '/admin/announcements');
    // Stepper: step 1 current, later steps not reachable yet; compact mobile label present.
    expect(screen.getByRole('navigation', { name: 'Announcement steps' })).toHaveTextContent('Step 1 of 4 · Write');
    expect(screen.getByText('Write', { selector: 'span' }).closest('[aria-current="step"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Preview & test/ })).toBeNull();

    await click('Save & continue');
    expect(screen.getByText('Enter a draft name.')).toBeInTheDocument();
    expect(screen.getByLabelText('Internal draft name')).toHaveFocus(); // first invalid field
    await userEvent.type(screen.getByLabelText('Internal draft name'), '  Spring update ');
    await userEvent.type(screen.getByLabelText('Email subject'), 'A note from For After');
    await userEvent.type(screen.getByLabelText('Message'), 'Hello.');
    await userEvent.click(toggle);
    await userEvent.type(screen.getByLabelText('Button label'), 'Open');
    await userEvent.click(toggle); // collapse: values kept
    await click('Save & continue');
    // A button error opens the section and focuses the field.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Choose where the button goes, or remove the button.')).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByLabelText('Destination')).toHaveFocus());
    await userEvent.selectOptions(screen.getByLabelText('Destination'), 'SUPPORT');
    await userEvent.dblClick(screen.getByRole('button', { name: /Save & continue/ }));
    expect(api.called('POST', '/admin/announcements')).toHaveLength(1);
    expect(api.called('POST', '/admin/announcements')[0]!.body).toEqual({
      name: 'Spring update',
      subject: 'A note from For After',
      body: 'Hello.',
      ctaLabel: 'Open',
      ctaDestination: 'SUPPORT',
    });
    // Opens the saved draft at step 2; locked meanwhile so no second copy is created.
    expect(router.replace).toHaveBeenCalledWith(`/admin/announcements/${ID}?step=preview`);
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(sends(api)).toHaveLength(0);
  });

  it('edit: saved values load, Draft badge, a configured button is summarised while collapsed, collapse keeps it, Remove deletes it', async () => {
    routes({ [`GET /admin/announcements/${ID}`]: json(200, draft({ ctaLabel: 'Get help', ctaDestination: 'SUPPORT' })) });
    renderWithClient(<AnnouncementEditor id={ID} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Edit announcement' })).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByLabelText('Internal draft name')).toHaveValue('Spring update');
    expect(screen.getByLabelText('Message')).toHaveValue(draft().body);
    expect(screen.getByText('Draft saved')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Button.*Get help.*Help & Support/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(screen.getByLabelText('Button label')).toHaveValue('Get help');
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    expect(screen.getByLabelText('Destination')).toHaveValue('SUPPORT');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    await click('Remove button');
    expect(screen.getByLabelText('Button label')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Add a button/ })).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('Save & continue waits for the save; a conflict keeps the text and stays on Write', async () => {
    let release: (r: Response) => void = () => undefined;
    const api = routes({
      [`PUT /admin/announcements/${ID}`]: () => new Promise<Response>((r) => (release = r)),
    });
    renderWithClient(<AnnouncementEditor id={ID} />);
    const body = await screen.findByLabelText('Message');
    await userEvent.type(body, ' My careful edit.');
    await click('Save & continue');
    expect(screen.getByRole('heading', { level: 2, name: 'Write your announcement' })).toBeInTheDocument(); // not advanced yet
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    release(json(409, { message: 'This draft was changed by someone else since you opened it.' }));
    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument();
    expect(body).toHaveValue('Hello.\n\nSecond paragraph. My careful edit.');
    expect(screen.getByRole('heading', { level: 2, name: 'Write your announcement' })).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(api.called('PUT', `/admin/announcements/${ID}`)[0]!.body).toMatchObject({ expectedVersion: 1 });
  });

  it('a successful save advances to Preview, focuses its heading and previews the SAVED version; unchanged drafts continue without re-saving', async () => {
    const api = routes({
      [`PUT /admin/announcements/${ID}`]: (b) => json(200, draft({ ...(b as object), version: 2 })),
    });
    renderWithClient(<AnnouncementEditor id={ID} />);
    const subject = await screen.findByLabelText('Email subject');
    await userEvent.clear(subject);
    await userEvent.type(subject, 'Saved subject');
    await click('Save & continue');
    const h = await step('Preview your email');
    expect(h).toHaveFocus();
    expect(window.location.search).toBe('?step=preview');
    expect(screen.queryByLabelText('Email subject')).toBeNull(); // only the active step
    const frame = await screen.findByTitle('Email preview');
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin'); // never allow-scripts
    expect(api.called('POST', '/admin/announcements/preview')[0]!.body).toEqual({
      subject: 'Saved subject',
      body: 'Hello.\n\nSecond paragraph.',
      ctaLabel: null,
      ctaDestination: null,
    });
    // Back keeps the in-memory form; continuing again does not save again.
    await click('Back');
    expect(await screen.findByLabelText('Email subject')).toHaveValue('Saved subject');
    await click('Save & continue');
    await step('Preview your email');
    expect(api.called('PUT', `/admin/announcements/${ID}`)).toHaveLength(1);
    expect(sends(api)).toHaveLength(0);
  });

  it('browser Back/Forward move between steps without losing anything; a direct link cannot skip unfinished steps', async () => {
    window.history.replaceState(null, '', `/admin/announcements/${ID}?step=send`);
    const api = routes();
    renderWithClient(<AnnouncementEditor id={ID} />);
    // Preview not passed yet in this visit: the link lands on the first unfinished step.
    expect(await step('Preview your email')).toBeInTheDocument();
    expect(api.called('POST', `/admin/announcements/${ID}/broadcast-review`)).toHaveLength(0);
    await click('Continue to audience');
    await step('Review your audience');
    window.history.back();
    expect(await step('Preview your email')).toBeInTheDocument();
    window.history.forward();
    expect(await step('Review your audience')).toBeInTheDocument();
    await click(/Write/); // completed step, revisitable from the stepper
    expect(await screen.findByLabelText('Internal draft name')).toHaveValue('Spring update');
    expect(sends(api)).toHaveLength(0);
  });

  it('Preview & test: unverified admin disables only the test action (with the reason); continuing stays available; nothing is sent by navigation', async () => {
    const api = routes({ 'GET /admin/announcements/test-destination': json(200, { email: null }) });
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toPreview();
    expect(await screen.findByText('Your account email is not verified, so test emails are unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Continue to audience/ })).toBeEnabled();
    expect(screen.getByText('Testing is optional. You can continue without sending a test.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull(); // read-only step
    await click('Continue to audience');
    await click('Back');
    await step('Preview your email');
    expect(sends(api)).toHaveLength(0);
  });

  it('test email: confirms the server-chosen destination, sends only an operation id and the saved version, reports provider acceptance', async () => {
    let polls = 0;
    const api = routes({
      [`POST /admin/announcements/${ID}/test-sends`]: () => json(202, test('QUEUED')),
      [`GET /admin/announcements/${ID}/test-sends/${TEST_ID}`]: () => json(200, test(polls++ ? 'ACCEPTED' : 'QUEUED')),
    });
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toPreview();
    const open = await screen.findByRole('button', { name: 'Send test email' });
    await vi.waitFor(() => expect(open).toBeEnabled());
    await userEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Send a test email?' });
    expect(within(dialog).getByText('root@example.test')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).toBeNull(); // no address can be typed
    await userEvent.dblClick(within(dialog).getByRole('button', { name: 'Send test email' }));
    const posts = api.called('POST', `/admin/announcements/${ID}/test-sends`);
    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]!.body as object).sort()).toEqual(['clientOperationId', 'expectedVersion']);
    expect(await screen.findByText(/Test email queued./)).toBeInTheDocument();
    expect(await screen.findByText(/Your email provider accepted the test email/, {}, { timeout: 6000 })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/delivered|was read|opened/i);
  });

  it('a refused test stays in the dialog and a retry reuses the operation id', async () => {
    const api = routes({ [`POST /admin/announcements/${ID}/test-sends`]: json(409, { message: 'The saved draft has changed since you opened it.' }) });
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toPreview();
    const open = await screen.findByRole('button', { name: 'Send test email' });
    await vi.waitFor(() => expect(open).toBeEnabled());
    await userEvent.click(open);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send test email' }));
    expect(await within(dialog).findByText(/saved draft has changed/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send test email' }));
    const posts = api.called('POST', `/admin/announcements/${ID}/test-sends`);
    expect((posts[1]!.body as { clientOperationId: string }).clientOperationId).toBe((posts[0]!.body as { clientOperationId: string }).clientOperationId);
  });

  it('a test of an earlier version is labelled as such and never counts for the current version', async () => {
    routes({
      [`GET /admin/announcements/${ID}`]: json(200, draft({ version: 2, latestTest: test('ACCEPTED', 1) })),
      [`GET /admin/announcements/${ID}/test-sends/${TEST_ID}`]: json(200, test('ACCEPTED', 1)),
      [`GET /admin/announcements/${ID}/audience`]: json(200, audience({ version: 2 })),
      [`POST /admin/announcements/${ID}/broadcast-review`]: json(200, sendReview({ version: 2 })),
    });
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toPreview();
    expect(await screen.findByText(/earlier version 1/)).toBeInTheDocument();
    await click('Continue to audience');
    const next = await screen.findByRole('button', { name: 'Continue to review' });
    await vi.waitFor(() => expect(next).toBeEnabled());
    await userEvent.click(next);
    await step('Review before sending');
    expect(await screen.findByText('Not sent for this version')).toBeInTheDocument();
  });

  it('Audience: real counts, "Not confirmed" while blockers are open, never a guessed number; Refresh re-checks', async () => {
    const api = routes();
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toAudience();
    expect(await screen.findByText('Not confirmed')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('Email not verified').nextSibling).toHaveTextContent('3');
    expect(screen.getByText('Has not opted in to product news').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Unsubscribed, bounced or complained').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Open death report (until it is resolved)').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('An open policy decision (test only).')).toBeInTheDocument();
    expect(screen.getByText('This is an audience review. No emails have been sent.')).toBeInTheDocument();
    expect(screen.getByText('Eligibility is checked again before each email is sent.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/example data|suppression/i);
    await click('Refresh review');
    await vi.waitFor(() => expect(api.called('GET', `/admin/announcements/${ID}/audience`)).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Continue to review' })).toBeEnabled();
  });

  it('Audience: a failed check is "unavailable" (never zero) and blocks continuing; a stale review asks for a refresh', async () => {
    routes({ [`GET /admin/announcements/${ID}/audience`]: json(503, { message: 'x' }) });
    const { unmount } = renderWithClient(<AnnouncementEditor id={ID} />);
    await toAudience();
    expect(await screen.findByText(/unavailable right now/)).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue to review' })).toBeDisabled();
    expect(screen.getByText('The audience check failed. Refresh the review to continue.')).toBeInTheDocument();
    unmount();
    window.history.replaceState(null, '', '/admin/announcements');
    routes({ [`GET /admin/announcements/${ID}`]: json(200, draft({ version: 2 })) }); // review answers for version 1
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toAudience();
    expect(await screen.findByText(/Out of date: the draft was saved again/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to review' })).toBeDisabled();
  });

  it('Review & send blocked: shows why, the checkbox and Queue stay disabled, nothing is queued', async () => {
    const api = routes({ [`POST /admin/announcements/${ID}/broadcast-review`]: json(200, blocked) });
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toSend();
    expect(await screen.findByText('Customer broadcasting is turned off on this server.')).toBeInTheDocument();
    expect(screen.getByText(/eligible customers not confirmed/)).toBeInTheDocument();
    expect(screen.getByText(/Optional product news \(opt-in only/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Queue announcement' })).toBeDisabled();
    expect(screen.getByText('Sending is not available: see the reasons above.')).toBeInTheDocument();
    expect(api.called('POST', `/admin/announcements/${ID}/broadcast-review`)[0]!.body).toEqual({ expectedVersion: 1 });
    expect(sends(api)).toHaveLength(0);
  });

  it('Review & send: summary, preview on demand, explicit confirmation, one queue request with the review token, then the progress view', async () => {
    const api = routes({
      [`POST /admin/announcements/${ID}/broadcasts`]: () => json(202, run({ status: 'PREPARING', preparedAt: null, audiencePrepared: false, prepared: 0 })),
      [`GET /admin/announcements/${ID}/broadcasts/${RUN}`]: json(200, run({ status: 'PREPARING', preparedAt: null, audiencePrepared: false, prepared: 0 })),
    });
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toSend();
    expect(await screen.findByText(/98 eligible customers/)).toBeInTheDocument();
    expect(screen.getByText('Spring update')).toBeInTheDocument();
    expect(screen.getByText(/info@example.test/)).toBeInTheDocument();
    expect(screen.getByText('Not sent')).toBeInTheDocument();
    const queue = screen.getByRole('button', { name: 'Queue announcement' });
    expect(queue).toBeDisabled();
    expect(screen.getByText('Confirm above to continue.')).toBeInTheDocument();
    const show = screen.getByRole('button', { name: 'View email preview' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(show);
    expect(await screen.findByTitle('Email preview')).toHaveAttribute('srcdoc', '<p>Saved email</p>');
    await userEvent.click(screen.getByRole('checkbox', { name: /I confirm this announcement is ready/ }));
    expect(queue).toBeEnabled();
    await userEvent.dblClick(queue);
    await vi.waitFor(() => expect(api.called('POST', `/admin/announcements/${ID}/broadcasts`)).toHaveLength(1));
    const body = api.called('POST', `/admin/announcements/${ID}/broadcasts`)[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['clientOperationId', 'expectedVersion', 'reviewToken']);
    expect(body).toMatchObject({ expectedVersion: 1, reviewToken: 'tok.sig' });
    // The results page replaces the wizard: no send controls remain.
    expect(await screen.findByRole('heading', { level: 1, name: 'Announcement results' })).toBeInTheDocument();
    expect(await screen.findByText('Total recipients', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Total recipients', { selector: 'span' }).nextSibling).toHaveTextContent('0 so far');
    expect(screen.queryByRole('navigation', { name: 'Announcement steps' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Queue announcement' })).toBeNull();
  });

  it('an uncertain queue result never sends blindly: "Check status" repeats the SAME operation; a definite refusal asks for a new review', async () => {
    let attempt = 0;
    const api = routes({
      [`POST /admin/announcements/${ID}/broadcasts`]: () =>
        attempt++ === 0 ? json(503, { message: 'x' }) : attempt === 2 ? json(409, { message: 'This review has expired or does not match the draft.' }) : json(202, run()),
      [`GET /admin/announcements/${ID}/broadcasts/${RUN}`]: json(200, run()),
    });
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toSend();
    await userEvent.click(await screen.findByRole('checkbox', { name: /I confirm/ }));
    await click('Queue announcement');
    expect(await screen.findByText(/could not confirm whether the announcement was queued/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queue announcement' })).toBeDisabled();
    await click('Check status');
    expect(await screen.findByText(/review has expired/)).toBeInTheDocument();
    const posts = api.called('POST', `/admin/announcements/${ID}/broadcasts`).map((c) => (c.body as { clientOperationId: string }).clientOperationId);
    expect(posts[1]).toBe(posts[0]);
    await click('Review again');
    await vi.waitFor(() => expect(api.called('POST', `/admin/announcements/${ID}/broadcast-review`)).toHaveLength(2));
    await userEvent.click(await screen.findByRole('checkbox', { name: /I confirm/ }));
    await click('Queue announcement');
    await screen.findByRole('heading', { level: 1, name: 'Announcement results' });
    const third = (api.called('POST', `/admin/announcements/${ID}/broadcasts`)[2]!.body as { clientOperationId: string }).clientOperationId;
    expect(third).not.toBe(posts[0]); // a new operation only after a definite refusal
  });

  it('editing after review: Edit message → save → later steps and the confirmation must be done again', async () => {
    let version = 1;
    routes({
      [`PUT /admin/announcements/${ID}`]: (b) => json(200, draft({ ...(b as object), version: ++version })),
      [`GET /admin/announcements/${ID}/audience`]: () => json(200, audience({ version })),
    });
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toSend();
    await userEvent.click(await screen.findByRole('checkbox', { name: /I confirm/ }));
    await click('Edit message');
    const subject = await screen.findByLabelText('Email subject');
    await userEvent.type(subject, ' (revised)');
    // Unsaved: later steps cannot be opened from the stepper.
    expect(screen.queryByRole('button', { name: /Review & send/ })).toBeNull();
    await click('Save & continue');
    await step('Preview your email');
    // Version 2: audience and review must be passed again.
    expect(screen.queryByRole('button', { name: /Review & send/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Audience/ })).toBeNull();
  });

  it('Step 7 audience: pilot is the default, members are added by exact address with their real status, and every change re-checks the review', async () => {
    let group = pilotGroup({ members: [] });
    const api = routes({
      [`GET /admin/announcements/${ID}/pilot`]: () => json(200, group),
      [`POST /admin/announcements/${ID}/pilot`]: (b) => {
        group = pilotGroup({ members: [{ userId: 'u2', email: (b as { email: string }).email, firstName: null, lastName: null, status: 'no_consent' }] });
        return json(200, group);
      },
      [`PUT /admin/announcements/${ID}/audience-scope`]: (b) => {
        group = pilotGroup({ audience: (b as { audience: 'PILOT' | 'ALL_ELIGIBLE' }).audience, members: [] });
        return json(200, group);
      },
    });
    renderWithClient(<AnnouncementEditor id={ID} />);
    await toAudience();
    expect(await screen.findByRole('radio', { name: /Pilot group \(recommended\)/ })).toBeChecked();
    expect(screen.getByText('No one is in the pilot group yet.')).toBeInTheDocument();
    const reviews = () => api.called('GET', `/admin/announcements/${ID}/audience`).length;
    const before = reviews();
    await userEvent.type(screen.getByLabelText('Add a customer by email'), 'test.customer@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Add to pilot' }));
    const list = await screen.findByRole('list', { name: 'Pilot group' });
    expect(within(list).getByText('test.customer@example.test')).toBeInTheDocument();
    expect(within(list).getByText('Has not opted in to product news')).toBeInTheDocument();
    expect(api.called('POST', `/admin/announcements/${ID}/pilot`)[0]!.body).toEqual({ email: 'test.customer@example.test' });
    await vi.waitFor(() => expect(reviews()).toBeGreaterThan(before)); // the review is checked again
    await userEvent.click(screen.getByRole('radio', { name: /All eligible customers/ }));
    await vi.waitFor(() => expect(api.called('PUT', `/admin/announcements/${ID}/audience-scope`)[0]!.body).toEqual({ audience: 'ALL_ELIGIBLE' }));
    expect(screen.queryByLabelText('Add a customer by email')).toBeNull();
    expect(sends(api)).toHaveLength(0);
  });

  describe('post-send status and monitoring', () => {
    const summary = (name: string, broadcast: AnnouncementSummary['broadcast']) => ({ ...draft({ name, latestTest: null }), id: name.replace(/ /g, '-'), broadcast });
    const runOf = (status: BroadcastStatus, issues = 0) => ({ id: RUN, status, audience: 'PILOT' as const, issues });

    it('list: the run decides the status (an admin test alone stays Draft); queued announcements open results, not Edit', async () => {
      routeFetch({
        'GET /admin-auth/me': json(200, ROOT),
        'GET /admin/announcements': json(200, {
          items: [
            summary('No run', null),
            // A tested draft: the list API never sets broadcast for tests.
            { ...summary('Tested only', null), latestTest: { id: 't1', status: 'ACCEPTED' } },
            summary('Run Preparing', runOf('PREPARING')),
            summary('Run Sending', runOf('SENDING')),
            summary('Run Clean', runOf('COMPLETED')),
            summary('Run Issues', runOf('COMPLETED', 3)),
            summary('Run Stopped', runOf('CANCELLED', 2)),
            summary('Run Blocked', runOf('BLOCKED', 1)),
          ],
          pagination: { page: 1, limit: 25, total: 8, pages: 1 },
        }),
      });
      renderWithClient(<AnnouncementList page={1} />);
      const table = await screen.findByRole('table', { name: 'Email announcement drafts' });
      const row = (name: string) => within(table).getByText(name, { selector: 'span.font-medium' }).closest('tr')!;
      const expectRow = (name: string, status: string, action: string) => {
        expect(within(row(name)).getAllByRole('cell')[2]).toHaveTextContent(new RegExp(`${status}$`));
        expect(within(row(name)).getByRole('link', { name: `${action} ${name}` })).toHaveAttribute('href', `/admin/announcements/${name.replace(/ /g, '-')}`);
      };
      expectRow('No run', 'Draft', 'Edit');
      expectRow('Tested only', 'Draft', 'Edit');
      expectRow('Run Preparing', 'Preparing audience', 'View progress');
      expectRow('Run Sending', 'Sending', 'View progress');
      expectRow('Run Clean', 'Completed', 'View results');
      expectRow('Run Issues', 'Completed with issues', 'View results');
      expectRow('Run Stopped', 'Stopped', 'View results');
      expectRow('Run Blocked', 'Stopped by server', 'View results');
      expect(within(row('Run Clean')).queryByRole('link', { name: /^Edit/ })).toBeNull();
    });

    it('list: coming back to the list re-reads run state even within the cache window', async () => {
      let status: BroadcastStatus = 'SENDING';
      const api = routeFetch({
        'GET /admin-auth/me': json(200, ROOT),
        'GET /admin/announcements': () => json(200, { items: [summary('Pilot', runOf(status))], pagination: { page: 1, limit: 25, total: 1, pages: 1 } }),
      });
      const { queryClient, unmount } = renderWithClient(<AnnouncementList page={1} />);
      expect(await screen.findByText('Sending')).toBeInTheDocument();
      unmount();
      status = 'COMPLETED';
      render(
        <QueryClientProvider client={queryClient}>
          <AnnouncementList page={1} />
        </QueryClientProvider>,
      );
      expect(await screen.findByText('Completed')).toBeInTheDocument();
      expect(api.called('GET', '/admin/announcements')).toHaveLength(2);
    });

  });
});
