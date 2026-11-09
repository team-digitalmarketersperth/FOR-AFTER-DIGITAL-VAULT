// Phase 24, §50 "Expired signed URL reused": does the real provider refuse an
// expired signature? Uploads ONE synthetic 1x1 PNG (private) to the
// development ImageKit account under phase24/<run>/, signs URLs for it with
// the app's own adapter (dist ImageKitMediaStorage.createAccessUrl), checks
// valid → 200, expired → refused, tampered expiry → refused, then deletes
// exactly that file. Prints statuses only (no keys, no URLs).
//
//   npm run build && node scripts/phase24/imagekit-expired-url-check.mjs
import { createRequire } from 'node:module';

process.loadEnvFile(new URL('../../.env', import.meta.url));
const require = createRequire(import.meta.url);
const { default: ImageKit } = require('@imagekit/nodejs');
const { ImageKitMediaStorage } = await import('../../dist/media/storage/imagekit-media-storage.service.js');

const config = { get: (k) => process.env[k] };
const storage = new ImageKitMediaStorage(config);
const client = new ImageKit({ privateKey: process.env.IMAGEKIT_PRIVATE_KEY });
const run = Date.now();
const folder = `/phase24/${run}/`;
const fileName = 'expiry-check.png';
// 1x1 transparent PNG, synthetic.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async (url) => (await fetch(url, { redirect: 'manual' })).status;

let fileId;
const results = {};
try {
  const file = await client.files.upload({
    file: new File([png], fileName, { type: 'image/png' }),
    fileName,
    folder,
    isPrivateFile: true,
    useUniqueFileName: false,
    overwriteFile: false,
  });
  fileId = file.fileId;
  const ref = { storageProvider: 'IMAGEKIT', storageKey: file.filePath.replace(/^\//, ''), providerFileId: fileId };

  // Unsigned access to a private file must be refused.
  results.unsigned = await status(`${process.env.IMAGEKIT_URL_ENDPOINT.replace(/\/$/, '')}/${ref.storageKey}`);
  const short = await storage.createAccessUrl(ref, 5);
  results.validWithinTtl = await status(short);
  // Tampered expiry: push ik-t forward without re-signing.
  const tampered = new URL(short);
  tampered.searchParams.set('ik-t', String(Number(tampered.searchParams.get('ik-t')) + 3600));
  results.tamperedExpiry = await status(tampered.href);
  await sleep(15_000);
  results.reusedAfterExpiry = await status(short);
} finally {
  if (fileId) {
    await client.files.delete(fileId);
    results.cleanup = 'deleted';
  }
}
const refused = (s) => s >= 400;
results.pass =
  results.validWithinTtl === 200 && refused(results.unsigned) && refused(results.tamperedExpiry) && refused(results.reusedAfterExpiry);
console.log(JSON.stringify(results));
process.exit(results.pass ? 0 : 1);
