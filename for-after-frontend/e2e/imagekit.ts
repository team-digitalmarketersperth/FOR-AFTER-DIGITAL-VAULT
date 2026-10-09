import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { test as base, type Response } from '@playwright/test';

export { expect } from '@playwright/test';

// The local API uploads to the development ImageKit account, so every test that
// uploads leaves synthetic files there. This fixture records the fileId of each
// upload made by the current test and deletes exactly those ids afterwards
// (ImageKit delete-by-id). It never lists, searches or enumerates the account.
// Pass ids of uploads made with page.request (no browser event) to `imagekitFiles.add`.

const UPLOAD = /^https:\/\/upload\.imagekit\.io\//;

// Same key the local API uses; read only, never printed.
function privateKey() {
  if (process.env.IMAGEKIT_PRIVATE_KEY) return process.env.IMAGEKIT_PRIVATE_KEY;
  const file = '../for-after-backend/.env';
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')).IMAGEKIT_PRIVATE_KEY : undefined;
}

/** Deletes these ImageKit files; returns the ids that could not be deleted. A missing file counts as deleted. */
export async function deleteImageKitFiles(fileIds: string[]) {
  const key = privateKey();
  if (!key) return fileIds;
  const auth = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  const failed: string[] = [];
  for (const id of fileIds) {
    const res = await fetch(`https://api.imagekit.io/v1/files/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: auth },
    }).catch(() => null);
    if (!res || (!res.ok && res.status !== 404)) failed.push(id);
  }
  return failed;
}

/**
 * Phase 13B: files the API copies server-side (a message made from a memory)
 * never pass through the browser, so their ids come from the local database:
 * exactly these messages' media rows, nothing listed at ImageKit. Test-only.
 */
export async function messageMediaFileIds(messageIds: string[]): Promise<string[]> {
  const backend = '../for-after-backend';
  const url = process.env.DATABASE_URL ?? parseEnv(fs.readFileSync(`${backend}/.env`, 'utf8')).DATABASE_URL;
  const { Client } = createRequire(`${process.cwd()}/${backend}/package.json`)('pg');
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows } = await db.query(
      'SELECT "providerFileId" FROM "MediaAsset" WHERE "messageId" = ANY($1::uuid[]) AND "providerFileId" IS NOT NULL',
      [messageIds],
    );
    return rows.map((r: { providerFileId: string }) => r.providerFileId);
  } finally {
    await db.end();
  }
}

export const test = base.extend<{ imagekitFiles: Set<string> }>({
  imagekitFiles: [
    async ({ context }, use, testInfo) => {
      const ids = new Set<string>();
      const pending: Promise<void>[] = [];
      const track = (res: Response) => {
        if (res.request().method() !== 'POST' || !UPLOAD.test(res.url())) return;
        pending.push(
          res
            .json()
            .then((body: { fileId?: string }) => void (body.fileId && ids.add(body.fileId)))
            .catch(() => undefined),
        );
      };
      context.on('response', track);
      await use(ids);
      context.off('response', track);
      await Promise.all(pending);

      // Runs after a failed test too. A cleanup failure is reported, and fails an
      // otherwise passing test, without replacing the test's own error.
      const failed = await deleteImageKitFiles([...ids]);
      if (!failed.length) return;
      const message = `ImageKit cleanup: ${failed.length} of ${ids.size} synthetic file(s) not deleted (${failed.join(', ')})`;
      testInfo.annotations.push({ type: 'imagekit-cleanup-failed', description: message });
      if (testInfo.status === testInfo.expectedStatus) throw new Error(message);
      console.error(message);
    },
    { auto: true },
  ],
});
