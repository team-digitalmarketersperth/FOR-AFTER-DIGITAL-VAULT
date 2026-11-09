import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import type { ConfigService } from '@nestjs/config';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { announcement, TEST_NOTICE } from '../email/email-templates.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AnnouncementTestQueue } from './announcement-test-queue.service.js';
import { AdminAnnouncementsController } from './announcements.controller.js';
import { AnnouncementsService, CTA_PAIRED } from './announcements.service.js';

const config = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as unknown as ConfigService;
const service = (env: Record<string, string>) => new AnnouncementsService({} as PrismaService, config(env), {} as AnnouncementTestQueue);
const content = { subject: 'Hello', body: 'One' };

describe('announcements', () => {
  it('guards: session, admin role + MFA, then SUPER_ADMIN only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminAnnouncementsController)).toEqual([SessionAuthGuard, AdminGuard, SuperAdminGuard]);
    const ctx = (role?: string) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }) }) as never;
    expect(new SuperAdminGuard().canActivate(ctx('SUPER_ADMIN'))).toBe(true);
    for (const role of ['ADMIN', 'CUSTOMER', undefined]) expect(() => new SuperAdminGuard().canActivate(ctx(role))).toThrow('Only a super admin');
  });

  it('renderer: escapes everything, keeps paragraphs and line breaks, button only for an app path', () => {
    const r = announcement(
      { subject: 'Hi <there>', body: 'A & B\r\nnext line\n\n\n<script>x</script>\n  \n{{name}}', cta: { label: 'Go "now"', path: '/dashboard' } },
      'https://app.example.test',
    );
    expect(r.subject).toBe('Hi <there>'); // a header, not HTML
    expect(r.html).toContain('<title>Hi &#60;there&#62;</title>');
    expect(r.html).toContain('A &#38; B<br>next line</p>');
    expect(r.html).toContain('&#60;script&#62;x&#60;/script&#62;');
    expect(r.html).not.toMatch(/<script|<img|https?:\/\/(?!app\.example\.test)/i);
    expect(r.html).toContain('{{name}}'); // no template language: shown as written
    expect(r.html).toContain('href="https://app.example.test/dashboard"');
    expect(r.html).toContain('Go &#34;now&#34;');
    expect(r.text).toContain('A & B\nnext line\n\n<script>x</script>\n\n{{name}}');
    // No button: the only link is the unsubscribe link (Step 7).
    const noButton = announcement({ ...content, cta: null }, 'https://app.example.test').html;
    expect(noButton.match(/<a /g)).toHaveLength(1);
    expect(noButton).toContain('href="https://app.example.test/unsubscribe"');
  });

  it('test variant: [TEST] subject, notice in both parts, same body; the preview stays untouched', () => {
    const input = { subject: 'Hi <you>', body: 'One', cta: null };
    const live = announcement(input, 'https://app.example.test');
    const test = announcement(input, 'https://app.example.test', true);
    expect(test.subject).toBe('[TEST] Hi <you>');
    expect(test.html).toContain(TEST_NOTICE);
    expect(test.text.startsWith(`For After`)).toBe(true);
    expect(test.text).toContain(TEST_NOTICE);
    expect(live.subject).toBe('Hi <you>');
    expect(live.html).not.toContain(TEST_NOTICE);
    expect(test.html.replace(/<p[^>]*><span[^>]*>This is a test[^<]*<.span><.p>/, '')).toBe(live.html);
  });

  it('preview: sender from the provider’s own setting, never a provider call; button fields paired', () => {
    const ms = service({ EMAIL_PROVIDER: 'microsoft', APP_BASE_URL: 'https://app.example.test', EMAIL_FROM: 'info@example.test' });
    expect(ms.preview(content).from).toEqual({ name: 'For After', address: 'info@example.test' });
    const off = service({ EMAIL_PROVIDER: 'disabled' });
    expect(off.preview(content).from).toEqual({ name: 'For After', address: null });
    expect(() => off.preview({ ...content, ctaLabel: 'Open' })).toThrow(CTA_PAIRED);
    expect(() => off.preview({ ...content, ctaDestination: 'SUPPORT' })).toThrow(CTA_PAIRED);
  });
});
