import type { INestApplication } from '@nestjs/common';
import { generate } from 'otplib';
import request from 'supertest';

/**
 * Step 16: an admin session needs password + TOTP. Signs a freshly promoted
 * admin in through the real flow (login → setup → confirm with a code from
 * otplib, as an authenticator app would) and returns the agent, the TOTP
 * secret and the one-time recovery codes. Test data only.
 */
export const adminSignIn = async (
  app: INestApplication,
  email: string,
  password: string,
) => {
  const agent = request.agent(app.getHttpServer());
  const login = await agent
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(200);
  const { challengeId, mfaSetupRequired } = login.body as {
    challengeId: string;
    mfaSetupRequired: boolean;
  };
  if (!mfaSetupRequired) {
    throw new Error(`adminSignIn expects a not-yet-enrolled admin: ${email}`);
  }
  const { secret } = (
    await agent
      .post('/api/v1/admin-auth/totp/setup')
      .send({ challengeId })
      .expect(200)
  ).body as { secret: string };
  const confirmed = await agent
    .post('/api/v1/admin-auth/totp/confirm')
    .send({ challengeId, code: await generate({ secret }) })
    .expect(200);
  return {
    agent,
    secret,
    recoveryCodes: confirmed.body.recoveryCodes as string[],
  };
};
