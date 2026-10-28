import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ConfigService } from '@nestjs/config';
import { maskEmail } from '../auth/dto/register.dto.js';
import { ADDRESS_RE, EmailSendError } from './email-provider.js';
import { emailProviderFor } from './email-provider.factory.js';
import { providerTest } from './email-templates.js';

/*
 * Local only: sends ONE test email through the configured EMAIL_PROVIDER to
 * an address given on the command line. No HTTP route exists for this.
 *
 *   npm run build
 *   npm run email:send-test -- --to you@example.com
 *
 * Refuses NODE_ENV=production. Prints the outcome and the provider's request
 * id; never the key, secret, token or the email itself. "Accepted" means the
 * provider took the message, not that it was delivered.
 */
if (existsSync('.env')) process.loadEnvFile('.env');

const { values } = parseArgs({ options: { to: { type: 'string' } } });
const to = values.to?.trim() ?? '';
if (!ADDRESS_RE.test(to)) {
  console.error('Usage: npm run email:send-test -- --to someone@example.com');
  process.exit(2);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refused: NODE_ENV=production. This command is for local checks only.');
  process.exit(2);
}

const config = new ConfigService(process.env);
try {
  const provider = emailProviderFor(config);
  if (provider.name === 'disabled') {
    console.error('EMAIL_PROVIDER is disabled: nothing would be sent. Set EMAIL_PROVIDER in .env.');
    process.exit(2);
  }
  const { providerMessageId } = await provider.send({
    kind: 'provider-test',
    to,
    ...providerTest(provider.name),
  });
  console.log(
    `Accepted by ${provider.name} for ${maskEmail(to)} (request id: ${providerMessageId ?? 'none'}). Accepted is not delivered: check the inbox, including spam.`,
  );
} catch (err) {
  console.error(
    err instanceof EmailSendError
      ? `Not sent: ${err.code} (retryable: ${err.retryable}).`
      : `Not sent: ${err instanceof Error ? err.message : 'unknown error'}`,
  );
  process.exit(1);
}
