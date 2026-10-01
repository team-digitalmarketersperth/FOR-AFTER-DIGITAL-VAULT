import { API } from './helpers';

// Fail fast with a clear message instead of 20 confusing timeouts.
export default async function globalSetup() {
  try {
    await fetch(`${API}/auth/me`);
  } catch {
    throw new Error(
      `The For After API is not reachable at ${API}. Start PostgreSQL, Redis and the NestJS backend (npm run start:dev in for-after-backend) first.`,
    );
  }
}
