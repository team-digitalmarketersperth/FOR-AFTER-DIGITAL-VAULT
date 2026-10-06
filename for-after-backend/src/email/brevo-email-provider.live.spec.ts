import { existsSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import {
  BrevoEmailProvider,
  createEmailProvider,
  emailSettings,
} from './email-provider.js';
import { messageReleased } from './email-templates.js';

/**
 * Opt-in real delivery through Brevo. Skipped unless BREVO_LIVE_TEST=1, so CI
 * and `npm test` never touch the network. Reads BREVO_API_KEY and
 * EMAIL_FROM_* from .env and sends one plain test email (no sign-in code) to
 * BREVO_LIVE_TEST_TO, or to the sender itself, a developer-owned address.
 *
 *   BREVO_LIVE_TEST=1 npx vitest run src/email/brevo-email-provider.live.spec.ts
 */
const live = process.env.BREVO_LIVE_TEST === '1';

describe.runIf(live)('BrevoEmailProvider (live, opt-in)', () => {
  it('delivers a test email and returns a Brevo message id', async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const config = new ConfigService({
      ...process.env,
      EMAIL_PROVIDER: 'brevo',
      NODE_ENV: 'development',
    });
    const email = createEmailProvider(config);
    expect(email).toBeInstanceOf(BrevoEmailProvider);
    const to =
      process.env.BREVO_LIVE_TEST_TO ||
      config.get<string>('EMAIL_FROM_ADDRESS');
    const result = await email.send({
      kind: 'message-released',
      to: to!,
      subject: 'For After email transport test',
      html: '<p>Brevo transport test from the For After backend. No action needed.</p>',
      text: 'Brevo transport test from the For After backend. No action needed.',
    });
    expect(result.providerMessageId).toEqual(expect.any(String));
  });

  // Step 24.1: the real "a message is waiting" template, fictional name, no code.
  it('delivers the release notification template', async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const config = new ConfigService({
      ...process.env,
      EMAIL_PROVIDER: 'brevo',
      NODE_ENV: 'development',
    });
    const to =
      process.env.BREVO_LIVE_TEST_TO ||
      config.get<string>('EMAIL_FROM_ADDRESS');
    const result = await createEmailProvider(config).send({
      kind: 'message-released',
      to: to!,
      ...messageReleased(emailSettings(config).appBaseUrl, 'Sample'),
    });
    expect(result.providerMessageId).toEqual(expect.any(String));
  });
});
