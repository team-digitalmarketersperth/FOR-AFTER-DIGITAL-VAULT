import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { IpBlock, IpBlockControls, IpBlockPage, SecurityEvent, SecurityPage } from '@/lib/api/admin';
import { json, renderWithClient, routeFetch, router } from '@/test/utils';
import { IpBlockList } from './ip-controls';
import { SecurityDetail, SecurityList } from './security-activity';

vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/security' }));

// Fictional data only; addresses are from the documentation ranges (RFC 5737 / 3849).
const REF = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const BLOCK_ID = '22222222-2222-4222-8222-222222222222';
const T = '2026-10-30T02:00:00.000Z';
const event = (over: Partial<SecurityEvent> = {}): SecurityEvent => ({
  reference: REF,
  recordedAt: T,
  eventType: 'ADMIN_MFA_FAILED',
  category: 'mfa_failure',
  outcome: 'failed',
  actorType: 'ADMIN',
  actorUserId: ADMIN,
  accountId: ADMIN,
  network: '203.0.113.0/24',
  sourceTrusted: false,
  reason: { method: 'totp', code: 'wrong_code', challengeInvalidated: true },
  ...over,
});
const BINS = [
  { bin: '2026-10-28T00:00', signIn: 3, mfaFailure: 0 },
  { bin: '2026-10-29T00:00', signIn: 0, mfaFailure: 0 },
  { bin: '2026-10-30T00:00', signIn: 2, mfaFailure: 1 },
];
const page = (items: SecurityEvent[], over: Partial<SecurityPage> = {}): SecurityPage => ({
  evaluatedAt: T,
  window: { from: '2026-09-30T02:00:00.000Z', to: T },
  counts: { admin_sign_in: 5, mfa_failure: items.length, recovery_code: 0, mfa_setup: 0, account_status: 0, account_credentials: 0, ip_controls: 0 },
  series: { unit: 'day', timeZone: 'Australia/Perth', bins: BINS },
  sources: [{ network: '203.0.113.0/24', count: 4 }],
  sourcesTrusted: false,
  items,
  pagination: { page: 1, limit: 25, total: items.length, pages: 1 },
  ...over,
});
const block = (over: Partial<IpBlock> = {}): IpBlock => ({
  id: BLOCK_ID,
  ip: '203.0.113.24',
  network: '203.0.113.0/24',
  reason: 'Reviewed repeated rejected requests',
  createdByName: 'Sample Admin',
  createdAt: T,
  expiresAt: '2026-10-30T03:00:00.000Z',
  revokedAt: null,
  revokedByName: null,
  status: 'active',
  ...over,
});
const CAN_MANAGE: IpBlockControls = { available: true, superAdmin: true, recentAuth: true, activeCount: 0 };
const blocks = (controls: Partial<IpBlockControls> = {}, items: IpBlock[] = []): IpBlockPage => ({
  controls: { ...CAN_MANAGE, ...controls },
  items,
  pagination: { page: 1, limit: 25, total: items.length, pages: 1 },
});
const UNAVAILABLE = { available: false, superAdmin: true, recentAuth: true };

describe('Security activity', () => {
  it('factual labels, coverage gaps, masked source, recorded counts; opening the page changes nothing', async () => {
    const { calls } = routeFetch({
      'GET /admin/security/events': json(200, page([event(), event({ reference: ADMIN, network: null })])),
      'GET /admin/security/ip-blocks': json(200, blocks(UNAVAILABLE)),
    });
    renderWithClient(<SecurityList filters={{ page: 1 }} />);
    const table = await screen.findByRole('table', { name: 'Security events' });
    expect(within(table).getAllByText('Admin two-factor failed')).toHaveLength(2);
    expect(within(table).getAllByRole('link', { name: /^View details/ })[0]).toHaveAttribute('href', `/admin/security/${REF}`);
    expect(within(table).getAllByText('Failed')).toHaveLength(2);
    expect(within(table).getByText('203.0.113.0/24')).toBeInTheDocument();
    expect(within(table).getByText(/Proxy attribution unverified · masked/)).toBeInTheDocument();
    expect(within(table).getByText('Source unavailable')).toBeInTheDocument();
    // Coverage: what is recorded, what is not, and what zero does not mean.
    expect(screen.getByText('Audit events are recorded rows, not every request.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Monitoring coverage' })).toHaveTextContent(
      /customer, recipient and trusted contact sign-in failures.*zero events here does not mean there were no attempts/,
    );
    // Cards: server counts per category, each a filter link; scope and sign-in steps stated.
    const summary = screen.getByRole('heading', { name: 'Recorded events in this period' }).closest('section')!;
    expect(within(summary).getByRole('link', { name: /Admin sign-in and sign-out events\s*5/ })).toHaveAttribute(
      'href',
      '/admin/security?category=admin_sign_in',
    );
    expect(within(summary).getByRole('link', { name: /Total recorded events\s*7/ })).toBeInTheDocument();
    expect(summary).toHaveTextContent(/use the date range only.*count recorded steps, not people or completed sign-ins/);
    expect(screen.getByText(/^Last refreshed .*\(.+\)\. Showing/)).toBeInTheDocument();
    // No alarm wording, no score, no invented location or device, no design-concept badges.
    expect(document.body.textContent).not.toMatch(/brute force|attack detected|under attack|security score|spamm|illustrative|proposed feature|design concept|userAgent|location|device/i);
    // Unavailable attribution: said plainly, no Block IP control.
    expect(await screen.findAllByText('IP blocking is unavailable for this source.')).not.toHaveLength(0);
    expect(screen.getByText('Unverified proxy sources can’t be blocked.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Block IP' })).not.toBeInTheDocument();
    // Read-only: refresh issues GETs only.
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/admin/security/events').length).toBeGreaterThan(1));
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('graph: real bins, both series named, an exact table alternative; no rows is not "no attempts"', async () => {
    routeFetch({
      'GET /admin/security/events': json(200, page([event()])),
      'GET /admin/security/ip-blocks': json(200, blocks()),
    });
    const { unmount } = renderWithClient(<SecurityList filters={{ page: 1 }} />);
    const chart = await screen.findByRole('img', { name: /Recorded rows per day, Australia\/Perth/ });
    expect(chart).toHaveAccessibleName(/Admin sign-in and sign-out events: 5 in total\. Admin two-factor failures: 1 in total/);
    const table = screen.getByRole('table', { name: 'Recorded rows per day' });
    const rows = within(table).getAllByRole('row').slice(1);
    // One row per bin, zero bins kept (a confirmed zero, not a gap), dates read as the zone's wall clock.
    expect(rows.map((r) => r.textContent)).toEqual(['Wed, 28 Oct 202630', 'Thu, 29 Oct 202600', 'Fri, 30 Oct 202621']);
    unmount();

    routeFetch({
      'GET /admin/security/events': json(200, page([], { series: { unit: 'hour', timeZone: 'UTC', bins: BINS.map((b) => ({ ...b, signIn: 0, mfaFailure: 0 })) } })),
      'GET /admin/security/ip-blocks': json(200, blocks()),
    });
    renderWithClient(<SecurityList filters={{ page: 1 }} />);
    expect(await screen.findByText(/No admin sign-in, sign-out or two-factor failure rows were recorded.*doesn’t show nothing was attempted/)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Recorded rows/ })).not.toBeInTheDocument();
  });

  it('loading, then a failed refresh keeps the last result and says it may be stale', async () => {
    let n = 0;
    routeFetch({
      'GET /admin/security/events': () => (n++ === 0 ? json(200, page([event()])) : json(503, { message: 'x' })),
      'GET /admin/security/ip-blocks': json(200, blocks()),
    });
    renderWithClient(<SecurityList filters={{ page: 1 }} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Loading security events/);
    await screen.findByRole('table', { name: 'Security events' });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Couldn’t refresh\. These results are from .* may be out of date/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Security events' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });

  it('a failed first load is an error, never zero counts; failed IP controls are unknown, not "none"', async () => {
    routeFetch({ 'GET /admin/security/events': json(503, { message: 'x' }), 'GET /admin/security/ip-blocks': json(503, { message: 'x' }) });
    renderWithClient(<SecurityList filters={{ page: 1 }} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('empty: unfiltered says what it covers; filtered offers Clear filters', async () => {
    routeFetch({ 'GET /admin/security/events': json(200, page([])), 'GET /admin/security/ip-blocks': json(200, blocks()) });
    const { unmount } = renderWithClient(<SecurityList filters={{ page: 1 }} />);
    expect(await screen.findByText('No security events recorded in this period')).toBeInTheDocument();
    expect(screen.getByText(/not a sign that nothing was attempted/)).toBeInTheDocument();
    unmount();
    renderWithClient(<SecurityList filters={{ page: 1, outcome: 'failed' }} />);
    expect(await screen.findByText('No recorded events match these filters')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Clear filters' })[0]).toHaveAttribute('href', '/admin/security');
  });

  it('filters: sent to the API as validated values with the viewer’s zone; bad ids are refused before the URL', async () => {
    routeFetch({
      'GET /admin/security/events': (_b, url) => {
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ page: '2', category: 'mfa_failure', accountId: ADMIN });
        expect(url.searchParams.get('tz')).toBeTruthy();
        expect(url.searchParams.get('from')).toMatch(/^2026-10-01T00:00:00/);
        expect(url.searchParams.get('to')).toMatch(/^2026-10-30T23:59:59\.999/);
        return json(200, page([event()]));
      },
      'GET /admin/security/ip-blocks': json(200, blocks()),
    });
    renderWithClient(<SecurityList filters={{ page: 2, category: 'mfa_failure', accountId: ADMIN, from: '2026-10-01', to: '2026-10-30' }} />);
    await screen.findByRole('table', { name: 'Security events' });
    router.replace.mockClear();
    await userEvent.clear(screen.getByLabelText('Event reference'));
    await userEvent.type(screen.getByLabelText('Event reference'), 'someone@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('Enter a full event reference.')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText('Outcome'), 'failed');
    expect(router.replace).toHaveBeenCalledWith(expect.stringMatching(/category=mfa_failure.*outcome=failed/), expect.anything());
  });

  it('detail: controlled reason text, verified accounts, safe related links only', async () => {
    routeFetch({ [`GET /admin/security/events/${REF}`]: json(200, event({ sourceTrusted: true })) });
    renderWithClient(<SecurityDetail reference={REF} />);
    expect(await screen.findByRole('heading', { name: 'Admin two-factor failed' })).toBeInTheDocument();
    expect(screen.getByText('Authenticator code · Code not accepted · password step must be repeated')).toBeInTheDocument();
    expect(screen.getByText(/Trusted attribution · masked/)).toBeInTheDocument();
    expect(screen.getByText(/never an address someone typed/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Same entry in the audit log' })).toHaveAttribute('href', `/admin/audit-logs/${REF}`);
    expect(screen.getByRole('link', { name: 'All security events for this account' })).toHaveAttribute('href', `/admin/security?accountId=${ADMIN}`);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('detail: an unknown reason is "Reason not recorded", never raw text', async () => {
    routeFetch({ [`GET /admin/security/events/${REF}`]: json(200, event({ reason: { method: null, code: null, challengeInvalidated: false } })) });
    renderWithClient(<SecurityDetail reference={REF} />);
    expect(await screen.findByText('Reason not recorded')).toBeInTheDocument();
  });
});

describe('IP controls', () => {
  const setup = (controls: Partial<IpBlockControls>, create?: Parameters<typeof routeFetch>[0][string]) =>
    routeFetch({
      'GET /admin/security/events': json(200, page([event()])),
      'GET /admin/security/ip-blocks': json(200, blocks(controls)),
      ...(create && { 'POST /admin/security/ip-blocks': create }),
    });

  it('masked source activity is never a block target and is not called abuse', async () => {
    setup({});
    renderWithClient(<SecurityList filters={{ page: 1 }} />);
    const panel = (await screen.findByRole('heading', { name: 'Recorded source activity' })).closest('section')!;
    expect(panel).toHaveTextContent(/203\.0\.113\.0\/24\s*4 rows/);
    expect(panel).toHaveTextContent('IP blocking is unavailable for this source.');
    expect(panel).toHaveTextContent(/Automated abuse detection is unavailable/);
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
  });

  it('only a super admin with recent two-factor gets Block IP; others are told why', async () => {
    setup({ superAdmin: false });
    const { unmount } = renderWithClient(<SecurityList filters={{ page: 1 }} />);
    expect(await screen.findByText('Only a super admin can block or revoke an address.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Block IP' })).not.toBeInTheDocument();
    unmount();
    setup({ recentAuth: false });
    renderWithClient(<SecurityList filters={{ page: 1 }} />);
    expect(await screen.findByText('Sign in again with two-factor to block or revoke an address.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Block IP' })).not.toBeInTheDocument();
  });

  it('Block IP: a dialog with scope, effect and shared-network warning; Escape closes it, returns focus and creates nothing', async () => {
    const { calls } = setup({}, json(201, block()));
    renderWithClient(<SecurityList filters={{ page: 1 }} />);
    const trigger = await screen.findByRole('button', { name: 'Block IP' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Block IP temporarily' });
    expect(within(dialog).getByLabelText('Duration')).toHaveValue('60');
    expect(within(dialog).getAllByRole('option').map((o) => o.textContent)).toEqual(['15 minutes', '1 hour', '24 hours']);
    expect(dialog).toHaveTextContent(/Scope:.*Health checks and the signed Stripe webhook are not affected/);
    expect(dialog).toHaveTextContent(/Effect:.*new requests from this address get a 403.*Signed-in sessions aren’t ended/);
    expect(dialog).toHaveTextContent(/Shared networks:/);
    expect(dialog).not.toHaveTextContent(/Existing sessions are unaffected/);
    // Required fields: nothing to confirm until both are filled.
    expect(within(dialog).getByRole('button', { name: 'Confirm temporary block' })).toBeDisabled();
    // Focus is inside the dialog; Escape closes it and focus returns to the trigger.
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('confirm: sends exactly what was entered; success only after the API saved it, with the stored address', async () => {
    let release!: () => void;
    const saved = new Promise<void>((r) => (release = r));
    const { called } = setup({}, async () => (await saved, json(201, block({ ip: '2001:db8::1' }))));
    renderWithClient(<SecurityList filters={{ page: 1 }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Block IP' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('IP address'), '  2001:DB8:0:0::1 ');
    await userEvent.selectOptions(within(dialog).getByLabelText('Duration'), '15');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Reviewed hosting logs');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm temporary block' }));
    expect(called('POST', '/admin/security/ip-blocks')[0]!.body).toEqual({ ip: '2001:DB8:0:0::1', durationMinutes: 15, reason: 'Reviewed hosting logs' });
    expect(screen.queryByText(/is blocked until/)).not.toBeInTheDocument();
    release();
    expect(await screen.findByText(/is blocked until/)).toHaveTextContent('2001:db8::1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('a refused block keeps the dialog open with the server’s reason and shows no success', async () => {
    setup({}, json(400, { message: 'This is your current address or the proxy in front of the API, so it can’t be blocked.' }));
    renderWithClient(<SecurityList filters={{ page: 1 }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Block IP' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('IP address'), '203.0.113.9');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Reviewed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm temporary block' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/your current address/);
    expect(screen.queryByText(/is blocked until/)).not.toBeInTheDocument();
  });
});

describe('Temporary IP blocks list', () => {
  it('statuses beyond colour; revoke needs confirmation; history stays', async () => {
    const { called } = routeFetch({
      'GET /admin/security/ip-blocks': json(200, blocks({}, [
        block(),
        block({ id: ADMIN, status: 'revoked', revokedAt: T, revokedByName: 'Sample Admin' }),
        block({ id: REF, status: 'expired' }),
      ])),
      [`POST /admin/security/ip-blocks/${BLOCK_ID}/revoke`]: json(200, block({ status: 'revoked', revokedAt: T })),
    });
    renderWithClient(<IpBlockList filters={{ page: 1 }} />);
    const table = await screen.findByRole('table', { name: 'Temporary IP blocks' });
    for (const s of ['Active', 'Revoked', 'Expired']) expect(within(table).getByText(s)).toBeInTheDocument();
    expect(within(table).getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
    await userEvent.click(within(table).getByRole('button', { name: 'Revoke' }));
    expect(called('POST', `/admin/security/ip-blocks/${BLOCK_ID}/revoke`)).toHaveLength(0);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Revoke this block?' })).getByRole('button', { name: 'Revoke block' }));
    await waitFor(() => expect(called('POST', `/admin/security/ip-blocks/${BLOCK_ID}/revoke`)).toHaveLength(1));
  });

  it('other admins see the masked network and no reason or actions', async () => {
    routeFetch({ 'GET /admin/security/ip-blocks': json(200, blocks({ superAdmin: false }, [block({ ip: null, reason: null })])) });
    renderWithClient(<IpBlockList filters={{ page: 1 }} />);
    const table = await screen.findByRole('table', { name: 'Temporary IP blocks' });
    expect(within(table).getByText('Masked for your role')).toBeInTheDocument();
    expect(within(table).getByText('Super admins only')).toBeInTheDocument();
    expect(within(table).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Block IP' })).not.toBeInTheDocument();
  });
});
