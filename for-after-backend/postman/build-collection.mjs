// Generates the Postman collection, environment and README from one list of
// requests. Run: node postman/build-collection.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';

// r(name, method, path, expectedStatus, options)
//   body: object (JSON, may contain {{vars}}) or raw string
//   msg: substring expected in the error "message"
//   save: { varName: 'expression over `j` (response JSON)' }
//   tests: extra pm.test lines
//   pre: pre-request script lines
//   url: full URL instead of {{baseUrl}} + path
const r = (name, method, path, status, o = {}) => ({ name, method, path, status, ...o });
const neg = (name, ...rest) => r(`NEG - ${name}`, ...rest);

const folders = [
  {
    name: '00 Health & Setup',
    description: 'No session needed. The first logout clears any cookie left from a previous run.',
    items: [
      r('Root - hello', 'GET', '', 200),
      r('Health - database', 'GET', '', 200, { url: '{{healthUrl}}/database', tests: ["pm.test('database connected', () => pm.expect(pm.response.json().database).to.eql('connected'));"] }),
      r('Health - redis', 'GET', '', 200, { url: '{{healthUrl}}/redis', tests: ["pm.test('redis connected', () => pm.expect(pm.response.json().redis).to.eql('connected'));"] }),
      r('Logout - reset session (safe without session)', 'POST', '/auth/logout', 200),
    ],
  },
  {
    name: '01 Unauthenticated (401)',
    description: 'Every protected route without a session cookie must return 401.',
    items: [
      neg('GET /auth/me without session', 'GET', '/auth/me', 401),
      neg('GET /recipients without session', 'GET', '/recipients', 401),
      neg('POST /recipients without session', 'POST', '/recipients', 401, { body: { firstName: 'Nope' } }),
      neg('GET /trusted-contacts without session', 'GET', '/trusted-contacts', 401),
      neg('GET /messages without session', 'GET', '/messages', 401),
      neg('GET schedule without session', 'GET', `/messages/${RANDOM_UUID}/schedule`, 401),
      neg('GET message media without session', 'GET', `/messages/${RANDOM_UUID}/media`, 401),
      neg('GET /memory-vault without session', 'GET', '/memory-vault', 401),
      neg('GET /my-story/prompts without session', 'GET', '/my-story/prompts', 401),
      neg('GET /my-wishes/prompts without session', 'GET', '/my-wishes/prompts', 401),
    ],
  },
  {
    name: '02 Auth',
    description:
      'Register and login are limited to 5 requests per minute per IP (each route counted separately). ' +
      'This folder sends exactly 5 registers, then a 6th to prove the limit. Wait 60s before re-running the collection.',
    items: [
      r('Register user A', 'POST', '/auth/register', 201, {
        pre: [
          "const stamp = Date.now();",
          "pm.collectionVariables.set('userAEmail', `qa.a.${stamp}@example.com`);",
          "pm.collectionVariables.set('userBEmail', `qa.b.${stamp}@example.com`);",
        ],
        body: { email: '{{userAEmail}}', password: '{{userPassword}}', firstName: 'Alice', lastName: 'Tester' },
        save: { userAId: 'j.id' },
        tests: [
          "pm.test('role is CUSTOMER', () => pm.expect(pm.response.json().role).to.eql('CUSTOMER'));",
          "pm.test('no password hash leaked', () => pm.expect(pm.response.json()).to.not.have.property('passwordHash'));",
        ],
      }),
      r('Register user B (for isolation tests)', 'POST', '/auth/register', 201, {
        body: { email: '{{userBEmail}}', password: '{{userPassword}}', firstName: 'Bob', lastName: 'Tester' },
      }),
      neg('Register duplicate email', 'POST', '/auth/register', 409, {
        body: { email: '{{userAEmail}}', password: '{{userPassword}}', firstName: 'Alice', lastName: 'Again' },
        msg: 'An account with this email already exists.',
      }),
      neg('Register password under 12 chars', 'POST', '/auth/register', 400, {
        body: { email: 'short.pw@example.com', password: 'short', firstName: 'A', lastName: 'B' },
        msg: 'password must be longer than or equal to 12 characters',
      }),
      neg('Register with extra field role=ADMIN', 'POST', '/auth/register', 400, {
        body: { email: 'role@example.com', password: '{{userPassword}}', firstName: 'A', lastName: 'B', role: 'ADMIN' },
        msg: 'property role should not exist',
      }),
      neg('Register 6th request in 60s (rate limit)', 'POST', '/auth/register', 429, {
        body: { email: 'not-an-email', password: '{{userPassword}}', firstName: 'A', lastName: 'B' },
        description: 'Returns 429 only when the 5 registers above ran in the last 60s. Run on its own, it returns 400 (invalid email).',
      }),
      neg('Login wrong password', 'POST', '/auth/login', 401, {
        body: { email: '{{userAEmail}}', password: 'WrongPassword123!' },
        msg: 'Invalid email or password.',
      }),
      neg('Login unknown email (same message, no user enumeration)', 'POST', '/auth/login', 401, {
        body: { email: 'nobody.here@example.com', password: '{{userPassword}}' },
        msg: 'Invalid email or password.',
      }),
      neg('Login missing password', 'POST', '/auth/login', 400, {
        body: { email: '{{userAEmail}}' },
      }),
      r('Login user A', 'POST', '/auth/login', 200, {
        body: { email: '{{userAEmail}}', password: '{{userPassword}}' },
        tests: ["pm.test('session cookie set', () => pm.expect(pm.cookies.has('for_after_session')).to.be.true);"],
      }),
      r('Me (user A)', 'GET', '/auth/me', 200, {
        tests: ["pm.test('is user A', () => pm.expect(pm.response.json().email).to.eql(pm.collectionVariables.get('userAEmail')));"],
      }),
    ],
  },
  {
    name: '03 Recipients (People I Love)',
    items: [
      r('Create recipient (all fields)', 'POST', '/recipients', 201, {
        body: { firstName: 'Sofia', lastName: 'Smith', relationship: 'Daughter', email: 'Sofia@Example.com', mobile: '+61400000000', birthday: '2001-06-01', privateNote: 'Loves sunflowers.' },
        save: { recipientId: 'j.id' },
        tests: [
          "pm.test('email normalised to lower case', () => pm.expect(pm.response.json().email).to.eql('sofia@example.com'));",
          "pm.test('no ownerUserId/deletedAt', () => pm.expect(pm.response.json()).to.not.have.any.keys('ownerUserId', 'deletedAt'));",
        ],
      }),
      r('Create recipient (firstName only)', 'POST', '/recipients', 201, { body: { firstName: 'Tom' }, save: { recipient2Id: 'j.id' } }),
      r('List recipients', 'GET', '/recipients', 200, { tests: ["pm.test('is array', () => pm.expect(pm.response.json()).to.be.an('array'));"] }),
      r('Get recipient', 'GET', '/recipients/{{recipientId}}', 200),
      r('Update recipient (clear lastName with null)', 'PATCH', '/recipients/{{recipientId}}', 200, {
        body: { relationship: 'Eldest daughter', lastName: null },
        tests: ["pm.test('lastName cleared', () => pm.expect(pm.response.json().lastName).to.be.null);"],
      }),
      neg('Create without firstName', 'POST', '/recipients', 400, { body: { lastName: 'Smith' } }),
      neg('Create with blank firstName', 'POST', '/recipients', 400, { body: { firstName: '   ' }, msg: 'firstName should not be empty' }),
      neg('Create with invalid email', 'POST', '/recipients', 400, { body: { firstName: 'X', email: 'not-an-email' }, msg: 'email must be an email' }),
      neg('Create with invalid mobile', 'POST', '/recipients', 400, { body: { firstName: 'X', mobile: 'call me' }, msg: 'mobile must be a phone number' }),
      neg('Create with wrong birthday format', 'POST', '/recipients', 400, { body: { firstName: 'X', birthday: '01/06/1970' }, msg: 'birthday must be YYYY-MM-DD' }),
      neg('Create with impossible birthday 2001-02-30', 'POST', '/recipients', 400, { body: { firstName: 'X', birthday: '2001-02-30' } }),
      neg('Create with privateNote over 2000 chars', 'POST', '/recipients', 400, { body: { firstName: 'X', privateNote: '{{long2001}}' } }),
      neg('Create with ownerUserId in body', 'POST', '/recipients', 400, { body: { firstName: 'X', ownerUserId: RANDOM_UUID }, msg: 'property ownerUserId should not exist' }),
      neg('Update firstName to null', 'PATCH', '/recipients/{{recipientId}}', 400, { body: { firstName: null } }),
      neg('Get with non-UUID id', 'GET', '/recipients/not-a-uuid', 400),
      neg('Get unknown id', 'GET', `/recipients/${RANDOM_UUID}`, 404, { msg: 'Recipient not found.' }),
      neg('Update unknown id', 'PATCH', `/recipients/${RANDOM_UUID}`, 404, { body: { firstName: 'X' } }),
      neg('Delete unknown id', 'DELETE', `/recipients/${RANDOM_UUID}`, 404),
    ],
  },
  {
    name: '04 Trusted Contacts',
    items: [
      r('Create trusted contact (email)', 'POST', '/trusted-contacts', 201, {
        body: { firstName: 'Maria', lastName: 'Lopez', relationship: 'Sister', email: 'maria@example.com' },
        save: { trustedContactId: 'j.id' },
      }),
      r('Create trusted contact (mobile only)', 'POST', '/trusted-contacts', 201, {
        body: { firstName: 'Dan', mobile: '+61411111111' },
        save: { trustedContact2Id: 'j.id' },
      }),
      r('List trusted contacts', 'GET', '/trusted-contacts', 200),
      r('Get trusted contact', 'GET', '/trusted-contacts/{{trustedContactId}}', 200),
      r('Update trusted contact (add mobile)', 'PATCH', '/trusted-contacts/{{trustedContactId}}', 200, { body: { mobile: '+61422222222' } }),
      neg('Create with neither email nor mobile', 'POST', '/trusted-contacts', 400, { body: { firstName: 'X' }, msg: 'Provide an email or a mobile (or both).' }),
      neg('Create with email and mobile both null', 'POST', '/trusted-contacts', 400, { body: { firstName: 'X', email: null, mobile: null }, msg: 'Provide an email or a mobile (or both).' }),
      neg('Update clearing the last contact method', 'PATCH', '/trusted-contacts/{{trustedContact2Id}}', 400, { body: { mobile: null }, msg: 'Provide an email or a mobile (or both).' }),
      neg('Create with invalid email', 'POST', '/trusted-contacts', 400, { body: { firstName: 'X', email: 'nope' } }),
      neg('Create with extra field', 'POST', '/trusted-contacts', 400, { body: { firstName: 'X', email: 'x@example.com', canAccessVault: true }, msg: 'property canAccessVault should not exist' }),
      neg('Get with non-UUID id', 'GET', '/trusted-contacts/123', 400),
      neg('Get unknown id', 'GET', `/trusted-contacts/${RANDOM_UUID}`, 404, { msg: 'Trusted contact not found.' }),
      r('Delete trusted contact 2', 'DELETE', '/trusted-contacts/{{trustedContact2Id}}', 204),
      neg('Get deleted trusted contact', 'GET', '/trusted-contacts/{{trustedContact2Id}}', 404, { msg: 'Trusted contact not found.' }),
      neg('Delete already deleted trusted contact', 'DELETE', '/trusted-contacts/{{trustedContact2Id}}', 404),
    ],
  },
  {
    name: '05 Messages',
    items: [
      r('Create TEXT message', 'POST', '/messages', 201, {
        body: { title: 'For Sofia', contentType: 'TEXT', textContent: 'I am so proud of you.', recipientIds: ['{{recipientId}}'] },
        save: { messageId: 'j.id' },
        tests: ["pm.test('status is DRAFT', () => pm.expect(pm.response.json().status).to.eql('DRAFT'));"],
      }),
      r('Create PHOTO draft (no photo yet)', 'POST', '/messages', 201, {
        body: { title: 'Photo for Sofia', contentType: 'PHOTO', recipientIds: ['{{recipientId}}'] },
        save: { photoMessageId: 'j.id' },
      }),
      r('Create message for recipient 2', 'POST', '/messages', 201, {
        body: { title: 'For Tom', textContent: 'Hello Tom.', recipientIds: ['{{recipient2Id}}'] },
        save: { orphanMessageId: 'j.id' },
        tests: ["pm.test('contentType defaults to TEXT', () => pm.expect(pm.response.json().contentType).to.eql('TEXT'));"],
      }),
      r('List messages', 'GET', '/messages', 200),
      r('Get message', 'GET', '/messages/{{messageId}}', 200),
      r('Update message (title, text, recipients)', 'PATCH', '/messages/{{messageId}}', 200, {
        body: { title: 'For my Sofia', textContent: '  Always proud of you.  ', recipientIds: ['{{recipientId}}', '{{recipient2Id}}'] },
        tests: [
          "pm.test('text trimmed', () => pm.expect(pm.response.json().textContent).to.eql('Always proud of you.'));",
          "pm.test('two recipients', () => pm.expect(pm.response.json().recipients).to.have.lengthOf(2));",
        ],
      }),
      r('Update message (back to one recipient)', 'PATCH', '/messages/{{messageId}}', 200, { body: { recipientIds: ['{{recipientId}}'] } }),
      neg('Create without title', 'POST', '/messages', 400, { body: { recipientIds: ['{{recipientId}}'] } }),
      neg('Create with title over 200 chars', 'POST', '/messages', 400, { body: { title: '{{long201}}', recipientIds: ['{{recipientId}}'] } }),
      neg('Create with contentType VIDEO', 'POST', '/messages', 400, { body: { title: 'T', contentType: 'VIDEO', recipientIds: ['{{recipientId}}'] }, msg: 'VIDEO is not available yet' }),
      neg('Create with status in body', 'POST', '/messages', 400, { body: { title: 'T', status: 'RELEASED', recipientIds: ['{{recipientId}}'] }, msg: 'property status should not exist' }),
      neg('Create with ownerUserId in body', 'POST', '/messages', 400, { body: { title: 'T', ownerUserId: RANDOM_UUID, recipientIds: ['{{recipientId}}'] } }),
      neg('Create without recipientIds', 'POST', '/messages', 400, { body: { title: 'T' } }),
      neg('Create with empty recipientIds', 'POST', '/messages', 400, { body: { title: 'T', recipientIds: [] } }),
      neg('Create with duplicate recipientIds', 'POST', '/messages', 400, { body: { title: 'T', recipientIds: ['{{recipientId}}', '{{recipientId}}'] }, msg: 'recipientIds must not contain duplicates' }),
      neg('Create with non-UUID recipientId', 'POST', '/messages', 400, { body: { title: 'T', recipientIds: ['abc'] } }),
      neg('Create with unknown recipientId', 'POST', '/messages', 400, { body: { title: 'T', recipientIds: [RANDOM_UUID] }, msg: 'One or more recipients are invalid.' }),
      neg('Create with textContent over 20000 chars', 'POST', '/messages', 400, { body: { title: 'T', textContent: '{{long20001}}', recipientIds: ['{{recipientId}}'] } }),
      neg('Update title to null', 'PATCH', '/messages/{{messageId}}', 400, { body: { title: null } }),
      neg('Get with non-UUID id', 'GET', '/messages/abc', 400),
      neg('Get unknown id', 'GET', `/messages/${RANDOM_UUID}`, 404, { msg: 'Message not found.' }),
      neg('Delete unknown id', 'DELETE', `/messages/${RANDOM_UUID}`, 404),
    ],
  },
  {
    name: '06 Message Schedules',
    description: '{{futureIso}} is set to one year from now by the collection pre-request script.',
    items: [
      neg('Get schedule of unscheduled message', 'GET', '/messages/{{messageId}}/schedule', 404, { msg: 'Schedule not found.' }),
      neg('Update schedule of unscheduled message', 'PATCH', '/messages/{{messageId}}/schedule', 404, { body: { triggerType: 'ON_DEATH' } }),
      neg('Delete schedule of unscheduled message', 'DELETE', '/messages/{{messageId}}/schedule', 404),
      neg('Schedule unknown message', 'POST', `/messages/${RANDOM_UUID}/schedule`, 404, { body: { triggerType: 'ON_DEATH' }, msg: 'Message not found.' }),
      neg('Schedule with non-UUID messageId', 'POST', '/messages/abc/schedule', 400, { body: { triggerType: 'ON_DEATH' } }),
      neg('Missing triggerType', 'POST', '/messages/{{messageId}}/schedule', 400, { body: {} }),
      neg('Reserved triggerType NOW', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'NOW' }, msg: 'triggerType must be one of' }),
      neg('Reserved triggerType BIRTHDAY', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'BIRTHDAY' } }),
      neg('FIXED_DATE without scheduledFor', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'FIXED_DATE' }, msg: 'FIXED_DATE requires scheduledFor.' }),
      neg('FIXED_DATE in the past', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'FIXED_DATE', scheduledFor: '2020-01-01T09:00:00Z' }, msg: 'scheduledFor must be in the future.' }),
      neg('FIXED_DATE without timezone offset', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'FIXED_DATE', scheduledFor: '2030-12-25T09:00:00' }, msg: 'timezone offset' }),
      neg('FIXED_DATE date only', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'FIXED_DATE', scheduledFor: '2030-12-25' } }),
      neg('FIXED_DATE impossible date 2030-02-30', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'FIXED_DATE', scheduledFor: '2030-02-30T09:00:00Z' } }),
      neg('FIXED_DATE with afterDeathDays', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'FIXED_DATE', scheduledFor: '{{futureIso}}', afterDeathDays: 5 }, msg: 'FIXED_DATE does not take afterDeathDays.' }),
      neg('ON_DEATH with scheduledFor', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'ON_DEATH', scheduledFor: '{{futureIso}}' }, msg: 'ON_DEATH does not take scheduledFor or afterDeathDays.' }),
      neg('AFTER_DEATH without afterDeathDays', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'AFTER_DEATH' }, msg: 'AFTER_DEATH requires afterDeathDays.' }),
      neg('AFTER_DEATH with afterDeathDays 36501', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'AFTER_DEATH', afterDeathDays: 36501 } }),
      neg('AFTER_DEATH with negative days', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'AFTER_DEATH', afterDeathDays: -1 } }),
      neg('AFTER_DEATH with decimal days', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'AFTER_DEATH', afterDeathDays: 1.5 } }),
      neg('status in body', 'POST', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'ON_DEATH', status: 'RELEASED' }, msg: 'property status should not exist' }),
      neg('Schedule PHOTO message without a ready photo', 'POST', '/messages/{{photoMessageId}}/schedule', 409, { body: { triggerType: 'ON_DEATH' }, msg: 'PHOTO messages require at least one ready photo.' }),
      r('Delete recipient 2 (setup for next test)', 'DELETE', '/recipients/{{recipient2Id}}', 204),
      neg('Schedule message whose only recipient was deleted', 'POST', '/messages/{{orphanMessageId}}/schedule', 400, { body: { triggerType: 'ON_DEATH' }, msg: 'Assign at least one recipient before scheduling.' }),
      neg('Get deleted recipient', 'GET', '/recipients/{{recipient2Id}}', 404, { msg: 'Recipient not found.' }),
      r('Schedule FIXED_DATE (1 year ahead)', 'POST', '/messages/{{messageId}}/schedule', 201, {
        body: { triggerType: 'FIXED_DATE', scheduledFor: '{{futureIso}}' },
        tests: ["pm.test('afterDeathDays null', () => pm.expect(pm.response.json().afterDeathDays).to.be.null);"],
      }),
      r('Get schedule', 'GET', '/messages/{{messageId}}/schedule', 200),
      r('Message is now SCHEDULED', 'GET', '/messages/{{messageId}}', 200, {
        tests: ["pm.test('status SCHEDULED', () => pm.expect(pm.response.json().status).to.eql('SCHEDULED'));"],
      }),
      neg('Schedule an already scheduled message', 'POST', '/messages/{{messageId}}/schedule', 409, { body: { triggerType: 'ON_DEATH' }, msg: 'Message already has a schedule.' }),
      neg('Edit a SCHEDULED message', 'PATCH', '/messages/{{messageId}}', 409, { body: { title: 'Changed' }, msg: 'Only draft messages can be changed or deleted.' }),
      neg('Delete a SCHEDULED message', 'DELETE', '/messages/{{messageId}}', 409, { msg: 'Only draft messages can be changed or deleted.' }),
      neg('Upload media to a SCHEDULED message', 'POST', '/messages/{{messageId}}/media/upload-url', 409, {
        body: { kind: 'PHOTO', originalFileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 },
        msg: 'Media can only be changed on a draft message.',
      }),
      r('Update schedule to AFTER_DEATH 30 days', 'PATCH', '/messages/{{messageId}}/schedule', 200, {
        body: { triggerType: 'AFTER_DEATH', afterDeathDays: 30 },
        tests: ["pm.test('scheduledFor cleared', () => pm.expect(pm.response.json().scheduledFor).to.be.null);"],
      }),
      neg('Update schedule ON_DEATH with afterDeathDays', 'PATCH', '/messages/{{messageId}}/schedule', 400, { body: { triggerType: 'ON_DEATH', afterDeathDays: 5 }, msg: 'ON_DEATH does not take scheduledFor or afterDeathDays.' }),
      r('Update schedule to ON_DEATH', 'PATCH', '/messages/{{messageId}}/schedule', 200, { body: { triggerType: 'ON_DEATH' } }),
      r('Unschedule', 'DELETE', '/messages/{{messageId}}/schedule', 204),
      r('Message is DRAFT again', 'GET', '/messages/{{messageId}}', 200, {
        tests: ["pm.test('status DRAFT', () => pm.expect(pm.response.json().status).to.eql('DRAFT'));"],
      }),
      neg('Get schedule after unschedule', 'GET', '/messages/{{messageId}}/schedule', 404, { msg: 'Schedule not found.' }),
    ],
  },
  {
    name: '07 Message Media',
    description:
      'Needs object storage (OBJECT_STORAGE_* in .env). For the full happy path: set photoSizeBytes in the environment ' +
      'to the exact size of a JPEG on your machine, and pick that file in the body of "Upload file to storage".',
    items: [
      r('Request photo upload URL', 'POST', '/messages/{{photoMessageId}}/media/upload-url', 201, {
        body: { kind: 'PHOTO', originalFileName: 'sofia.jpg', mimeType: 'image/jpeg', sizeBytes: '{{photoSizeBytes}}' },
        save: { mediaAssetId: 'j.mediaAssetId', uploadUrl: 'j.uploadUrl', uploadContentType: "j.requiredHeaders['Content-Type']" },
      }),
      neg('Complete before uploading the file', 'POST', '/messages/{{photoMessageId}}/media/{{mediaAssetId}}/complete', 409, { msg: 'The file has not been uploaded yet.' }),
      neg('Access URL before READY', 'GET', '/messages/{{photoMessageId}}/media/{{mediaAssetId}}/access-url', 409, { msg: 'Media is not ready.' }),
      r('Upload file to storage (signed PUT, no session)', 'PUT', '', 200, {
        url: '{{uploadUrl}}',
        file: true,
        headers: [{ key: 'Content-Type', value: '{{uploadContentType}}' }],
        description: 'Goes straight to the bucket, not the API. Select a JPEG whose size equals photoSizeBytes in Body > binary.',
      }),
      r('Complete upload', 'POST', '/messages/{{photoMessageId}}/media/{{mediaAssetId}}/complete', 200, {
        tests: ["pm.test('READY', () => pm.expect(pm.response.json().status).to.eql('READY'));"],
      }),
      r('List message media', 'GET', '/messages/{{photoMessageId}}/media', 200, {
        tests: ["pm.test('no storageKey leaked', () => pm.response.json().forEach(m => pm.expect(m).to.not.have.property('storageKey')));"],
      }),
      r('Get access URL', 'GET', '/messages/{{photoMessageId}}/media/{{mediaAssetId}}/access-url', 200, {
        tests: ["pm.test('has url', () => pm.expect(pm.response.json().url).to.be.a('string'));"],
      }),
      neg('Upload kind VIDEO', 'POST', '/messages/{{photoMessageId}}/media/upload-url', 400, { body: { kind: 'VIDEO', originalFileName: 'x.mp4', mimeType: 'video/mp4', sizeBytes: 1000 }, msg: 'kind must be PHOTO or AUDIO' }),
      neg('Upload SVG', 'POST', '/messages/{{photoMessageId}}/media/upload-url', 400, { body: { kind: 'PHOTO', originalFileName: 'x.svg', mimeType: 'image/svg+xml', sizeBytes: 1000 }, msg: 'mimeType is not supported' }),
      neg('PHOTO with audio MIME type', 'POST', '/messages/{{photoMessageId}}/media/upload-url', 400, { body: { kind: 'PHOTO', originalFileName: 'x.mp3', mimeType: 'audio/mpeg', sizeBytes: 1000 } }),
      neg('Wildcard MIME type image/*', 'POST', '/messages/{{photoMessageId}}/media/upload-url', 400, { body: { kind: 'PHOTO', originalFileName: 'x.jpg', mimeType: 'image/*', sizeBytes: 1000 } }),
      neg('Photo over 20 MB', 'POST', '/messages/{{photoMessageId}}/media/upload-url', 400, { body: { kind: 'PHOTO', originalFileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 20971521 } }),
      neg('Audio over 100 MB', 'POST', '/messages/{{photoMessageId}}/media/upload-url', 400, { body: { kind: 'AUDIO', originalFileName: 'x.mp3', mimeType: 'audio/mpeg', sizeBytes: 104857601 } }),
      neg('sizeBytes 0', 'POST', '/messages/{{photoMessageId}}/media/upload-url', 400, { body: { kind: 'PHOTO', originalFileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 0 } }),
      neg('Empty originalFileName', 'POST', '/messages/{{photoMessageId}}/media/upload-url', 400, { body: { kind: 'PHOTO', originalFileName: '  ', mimeType: 'image/jpeg', sizeBytes: 1000 } }),
      neg('storageKey in body', 'POST', '/messages/{{photoMessageId}}/media/upload-url', 400, { body: { kind: 'PHOTO', originalFileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 1000, storageKey: 'hack/x.jpg' }, msg: 'property storageKey should not exist' }),
      neg('Upload URL for unknown message', 'POST', `/messages/${RANDOM_UUID}/media/upload-url`, 404, { body: { kind: 'PHOTO', originalFileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 }, msg: 'Message not found.' }),
      neg('Complete unknown media', 'POST', `/messages/{{photoMessageId}}/media/${RANDOM_UUID}/complete`, 404, { msg: 'Media not found.' }),
      neg('Access URL with non-UUID media id', 'GET', '/messages/{{photoMessageId}}/media/abc/access-url', 400),
      r('Delete media', 'DELETE', '/messages/{{photoMessageId}}/media/{{mediaAssetId}}', 204),
      neg('Access URL of deleted media', 'GET', '/messages/{{photoMessageId}}/media/{{mediaAssetId}}/access-url', 404, { msg: 'Media not found.' }),
      r('Delete PHOTO draft message', 'DELETE', '/messages/{{photoMessageId}}', 204),
      neg('Get deleted message', 'GET', '/messages/{{photoMessageId}}', 404, { msg: 'Message not found.' }),
    ],
  },
  {
    name: '08 Memory Vault',
    items: [
      r('Create memory', 'POST', '/memory-vault', 201, {
        body: { title: 'Summer at the beach', category: 'FAMILY', textContent: 'We built the biggest sandcastle.' },
        save: { memoryId: 'j.id' },
      }),
      r('Create second memory (to delete)', 'POST', '/memory-vault', 201, { body: { title: 'Grandma\'s pie', category: 'RECIPES' }, save: { memory2Id: 'j.id' } }),
      r('List memories', 'GET', '/memory-vault', 200),
      r('List memories by category', 'GET', '/memory-vault?category=FAMILY', 200, {
        tests: ["pm.test('only FAMILY', () => pm.response.json().forEach(m => pm.expect(m.category).to.eql('FAMILY')));"],
      }),
      r('Get memory', 'GET', '/memory-vault/{{memoryId}}', 200),
      r('Update memory', 'PATCH', '/memory-vault/{{memoryId}}', 200, { body: { title: 'Summer at Cottesloe', category: 'TRAVEL' } }),
      r('Update memory (clear text with null)', 'PATCH', '/memory-vault/{{memoryId}}', 200, {
        body: { textContent: null },
        tests: ["pm.test('text cleared', () => pm.expect(pm.response.json().textContent).to.be.null);"],
      }),
      neg('Create without category', 'POST', '/memory-vault', 400, { body: { title: 'T' } }),
      neg('Create with unknown category', 'POST', '/memory-vault', 400, { body: { title: 'T', category: 'SPORTS' }, msg: 'category must be one of' }),
      neg('Create with blank title', 'POST', '/memory-vault', 400, { body: { title: '   ', category: 'OTHER' } }),
      neg('Create with recipientIds (memories are private)', 'POST', '/memory-vault', 400, { body: { title: 'T', category: 'OTHER', recipientIds: ['{{recipientId}}'] }, msg: 'property recipientIds should not exist' }),
      neg('List with unknown category', 'GET', '/memory-vault?category=SPORTS', 400),
      neg('Get with non-UUID id', 'GET', '/memory-vault/abc', 400),
      neg('Get unknown id', 'GET', `/memory-vault/${RANDOM_UUID}`, 404, { msg: 'Memory not found.' }),
      r('Request memory audio upload URL', 'POST', '/memory-vault/{{memoryId}}/media/upload-url', 201, {
        body: { kind: 'AUDIO', originalFileName: 'voice.m4a', mimeType: 'audio/mp4', sizeBytes: 5000 },
        save: { memoryMediaAssetId: 'j.mediaAssetId' },
      }),
      neg('Complete memory upload before uploading', 'POST', '/memory-vault/{{memoryId}}/media/{{memoryMediaAssetId}}/complete', 409, { msg: 'The file has not been uploaded yet.' }),
      neg('Memory access URL before READY', 'GET', '/memory-vault/{{memoryId}}/media/{{memoryMediaAssetId}}/access-url', 409, { msg: 'Media is not ready.' }),
      r('List memory media', 'GET', '/memory-vault/{{memoryId}}/media', 200),
      neg('Memory upload kind VIDEO', 'POST', '/memory-vault/{{memoryId}}/media/upload-url', 400, { body: { kind: 'VIDEO', originalFileName: 'x.mp4', mimeType: 'video/mp4', sizeBytes: 1000 } }),
      neg('Memory upload to unknown memory', 'POST', `/memory-vault/${RANDOM_UUID}/media/upload-url`, 404, { body: { kind: 'PHOTO', originalFileName: 'x.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 }, msg: 'Memory not found.' }),
      r('Delete memory media', 'DELETE', '/memory-vault/{{memoryId}}/media/{{memoryMediaAssetId}}', 204),
      r('Delete second memory', 'DELETE', '/memory-vault/{{memory2Id}}', 204),
      neg('Get deleted memory', 'GET', '/memory-vault/{{memory2Id}}', 404, { msg: 'Memory not found.' }),
    ],
  },
  {
    name: '09 My Story',
    items: [
      r('List prompts', 'GET', '/my-story/prompts', 200),
      r('List prompts by category', 'GET', '/my-story/prompts?category=CHILDHOOD', 200),
      r('Get prompt (unanswered)', 'GET', '/my-story/prompts/childhood.earliest-memory', 200, {
        tests: ["pm.test('response null', () => pm.expect(pm.response.json().response).to.be.null);"],
      }),
      neg('Get response before answering', 'GET', '/my-story/prompts/childhood.earliest-memory/response', 404, { msg: 'Response not found.' }),
      r('Save answer (create)', 'PUT', '/my-story/prompts/childhood.earliest-memory/response', 200, { body: { textContent: 'The smell of rain on the veranda.' } }),
      r('Save answer (update)', 'PUT', '/my-story/prompts/childhood.earliest-memory/response', 200, { body: { textContent: 'The smell of rain on the veranda in Perth.' } }),
      r('Get answer', 'GET', '/my-story/prompts/childhood.earliest-memory/response', 200),
      r('Get prompt (answered)', 'GET', '/my-story/prompts/childhood.earliest-memory', 200, {
        tests: ["pm.test('answered', () => pm.expect(pm.response.json().answered).to.be.true);"],
      }),
      neg('Save blank answer', 'PUT', '/my-story/prompts/childhood.earliest-memory/response', 400, { body: { textContent: '   ' }, msg: 'textContent must not be blank' }),
      neg('Save without textContent', 'PUT', '/my-story/prompts/childhood.earliest-memory/response', 400, { body: {} }),
      neg('Save non-string textContent', 'PUT', '/my-story/prompts/childhood.earliest-memory/response', 400, { body: { textContent: 123 } }),
      neg('Save answer over 20000 chars', 'PUT', '/my-story/prompts/childhood.earliest-memory/response', 400, { body: { textContent: '{{long20001}}' } }),
      neg('Save with promptTextSnapshot in body', 'PUT', '/my-story/prompts/childhood.earliest-memory/response', 400, { body: { textContent: 'x', promptTextSnapshot: 'fake' }, msg: 'property promptTextSnapshot should not exist' }),
      neg('Malformed promptKey (uppercase)', 'GET', '/my-story/prompts/CHILDHOOD.EARLIEST-MEMORY', 400, { msg: 'promptKey is not valid' }),
      neg('Unknown promptKey', 'GET', '/my-story/prompts/childhood.does-not-exist', 404, { msg: 'Prompt not found.' }),
      neg('My Wishes key on My Story', 'GET', '/my-story/prompts/ceremony.style', 404),
      neg('Unknown category', 'GET', '/my-story/prompts?category=CEREMONY', 400),
      r('Delete answer', 'DELETE', '/my-story/prompts/childhood.earliest-memory/response', 204),
      neg('Delete answer again', 'DELETE', '/my-story/prompts/childhood.earliest-memory/response', 404, { msg: 'Response not found.' }),
      r('Answer again after delete (restore)', 'PUT', '/my-story/prompts/childhood.earliest-memory/response', 200, { body: { textContent: 'A second answer.' } }),
    ],
  },
  {
    name: '10 My Wishes',
    items: [
      r('List wish prompts', 'GET', '/my-wishes/prompts', 200),
      r('List wish prompts by category', 'GET', '/my-wishes/prompts?category=CEREMONY', 200),
      r('Get wish prompt (unanswered)', 'GET', '/my-wishes/prompts/ceremony.style', 200),
      neg('Get wish before answering', 'GET', '/my-wishes/prompts/ceremony.style/response', 404, { msg: 'Response not found.' }),
      r('Save wish', 'PUT', '/my-wishes/prompts/ceremony.style/response', 200, { body: { textContent: 'Something small, by the ocean.' } }),
      r('Get wish', 'GET', '/my-wishes/prompts/ceremony.style/response', 200),
      neg('Save blank wish', 'PUT', '/my-wishes/prompts/ceremony.style/response', 400, { body: { textContent: '' } }),
      neg('Save with acceptedLegalDisclaimer', 'PUT', '/my-wishes/prompts/ceremony.style/response', 400, { body: { textContent: 'x', acceptedLegalDisclaimer: true }, msg: 'property acceptedLegalDisclaimer should not exist' }),
      neg('Malformed promptKey (path traversal)', 'GET', '/my-wishes/prompts/..%2Fsecret', 400),
      neg('My Story key on My Wishes', 'GET', '/my-wishes/prompts/childhood.earliest-memory', 404),
      neg('Unknown category', 'GET', '/my-wishes/prompts?category=CHILDHOOD', 400),
      neg('Old /wishes route does not exist', 'GET', '/wishes', 404),
      r('Delete wish', 'DELETE', '/my-wishes/prompts/ceremony.style/response', 204),
      neg('Get deleted wish', 'GET', '/my-wishes/prompts/ceremony.style/response', 404),
    ],
  },
  {
    name: '11 Cross-account Isolation (user B)',
    description: 'User B must never see or change user A\'s data. Every attempt returns 404 (or 400 for recipients), never 403, so ids are not confirmed.',
    items: [
      r('Login user B', 'POST', '/auth/login', 200, { body: { email: '{{userBEmail}}', password: '{{userPassword}}' } }),
      r('Me (user B)', 'GET', '/auth/me', 200, {
        tests: ["pm.test('is user B', () => pm.expect(pm.response.json().email).to.eql(pm.collectionVariables.get('userBEmail')));"],
      }),
      r('B lists recipients (empty)', 'GET', '/recipients', 200, { tests: ["pm.test('empty', () => pm.expect(pm.response.json()).to.have.lengthOf(0));"] }),
      neg("B gets A's recipient", 'GET', '/recipients/{{recipientId}}', 404, { msg: 'Recipient not found.' }),
      neg("B updates A's recipient", 'PATCH', '/recipients/{{recipientId}}', 404, { body: { firstName: 'Hacked' } }),
      neg("B deletes A's recipient", 'DELETE', '/recipients/{{recipientId}}', 404),
      neg("B gets A's trusted contact", 'GET', '/trusted-contacts/{{trustedContactId}}', 404),
      neg("B gets A's message", 'GET', '/messages/{{messageId}}', 404, { msg: 'Message not found.' }),
      neg("B deletes A's message", 'DELETE', '/messages/{{messageId}}', 404),
      neg("B creates message for A's recipient", 'POST', '/messages', 400, { body: { title: 'T', textContent: 'x', recipientIds: ['{{recipientId}}'] }, msg: 'One or more recipients are invalid.' }),
      neg("B schedules A's message", 'POST', '/messages/{{messageId}}/schedule', 404, { body: { triggerType: 'ON_DEATH' }, msg: 'Message not found.' }),
      neg("B lists A's message media", 'GET', '/messages/{{messageId}}/media', 404),
      neg("B gets A's memory", 'GET', '/memory-vault/{{memoryId}}', 404, { msg: 'Memory not found.' }),
      neg("B lists A's memory media", 'GET', '/memory-vault/{{memoryId}}/media', 404),
      r("B's My Story is empty", 'GET', '/my-story/prompts/childhood.earliest-memory', 200, {
        tests: ["pm.test('does not see A\\'s answer', () => pm.expect(pm.response.json().response).to.be.null);"],
      }),
    ],
  },
  {
    name: '12 Logout',
    items: [
      r('Logout', 'POST', '/auth/logout', 200, { tests: ["pm.test('success', () => pm.expect(pm.response.json().success).to.be.true);"] }),
      neg('Me after logout', 'GET', '/auth/me', 401),
      neg('Recipients after logout', 'GET', '/recipients', 401),
      r('Logout again (still 200)', 'POST', '/auth/logout', 200),
    ],
  },
];

// ---- build ---------------------------------------------------------------

const toItem = (req) => {
  const exec = [
    `pm.test('Status is ${req.status}', () => pm.response.to.have.status(${req.status}));`,
  ];
  if (req.msg) {
    exec.push(
      `pm.test('Message contains: ${req.msg.replace(/'/g, "\\'")}', () => {`,
      "  const m = pm.response.json().message;",
      `  pm.expect([].concat(m).join(' | ')).to.include(${JSON.stringify(req.msg)});`,
      '});',
    );
  }
  if (req.save) {
    exec.push(`if (pm.response.code === ${req.status}) {`, '  const j = pm.response.json();');
    for (const [name, expr] of Object.entries(req.save)) {
      exec.push(`  pm.collectionVariables.set('${name}', ${expr});`);
    }
    exec.push('}');
  }
  if (req.tests) exec.push(`if (pm.response.code === ${req.status}) {`, ...req.tests.map((t) => '  ' + t), '}');

  const event = [{ listen: 'test', script: { type: 'text/javascript', exec } }];
  if (req.pre) event.unshift({ listen: 'prerequest', script: { type: 'text/javascript', exec: req.pre } });

  const header = [...(req.headers ?? [])];
  let body;
  if (req.file) {
    body = { mode: 'file', file: {} };
  } else if (req.body !== undefined) {
    header.push({ key: 'Content-Type', value: 'application/json' });
    // Numeric placeholders like "{{photoSizeBytes}}" must be sent unquoted.
    const raw = JSON.stringify(req.body, null, 2).replace(/"\{\{(photoSizeBytes)\}\}"/g, '{{$1}}');
    body = { mode: 'raw', raw, options: { raw: { language: 'json' } } };
  }

  return {
    name: req.name,
    event,
    request: {
      method: req.method,
      header,
      ...(body && { body }),
      url: req.url ?? `{{baseUrl}}${req.path}`,
      description: [`Expected: ${req.status}`, req.msg && `Message: ${req.msg}`, req.description].filter(Boolean).join('\n\n'),
    },
  };
};

const collectionPre = [
  '// Values used in request bodies.',
  "pm.collectionVariables.set('futureIso', new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString());",
  "if (!pm.collectionVariables.get('long20001')) {",
  "  pm.collectionVariables.set('long201', 'x'.repeat(201));",
  "  pm.collectionVariables.set('long2001', 'x'.repeat(2001));",
  "  pm.collectionVariables.set('long20001', 'x'.repeat(20001));",
  '}',
];

const collection = {
  info: {
    name: 'For After API',
    description:
      'Positive and negative (NEG) tests for every implemented For After API route.\n\n' +
      'Run the whole collection in order with the Collection Runner: requests save ids into collection variables ' +
      'that later requests use. Auth is a session cookie (for_after_session) that Postman keeps automatically after login.\n\n' +
      'Select the "For After - Local" environment first.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: collectionPre } }],
  variable: [
    'userAEmail', 'userBEmail', 'userAId', 'recipientId', 'recipient2Id', 'trustedContactId', 'trustedContact2Id',
    'messageId', 'photoMessageId', 'orphanMessageId', 'mediaAssetId', 'uploadUrl', 'uploadContentType',
    'memoryId', 'memory2Id', 'memoryMediaAssetId', 'futureIso', 'long201', 'long2001', 'long20001',
  ].map((key) => ({ key, value: '' })),
  item: folders.map((f) => ({ name: f.name, description: f.description, item: f.items.map(toItem) })),
};

const environment = {
  name: 'For After - Local',
  values: [
    { key: 'baseUrl', value: 'http://localhost:4000/api/v1', enabled: true },
    { key: 'healthUrl', value: 'http://localhost:4000/health', enabled: true },
    { key: 'userPassword', value: 'CorrectHorse-Battery-9', enabled: true },
    { key: 'photoSizeBytes', value: '12345', enabled: true },
  ],
  _postman_variable_scope: 'environment',
};

// README: one table per folder.
const md = [
  '# 🧪 For After API — Postman tests (generated JSON collection)',
  '',
  '> Generated by `node postman/build-collection.mjs`; edit that file, not the JSON or this README.',
  '',
  '| Collection | Covers | Where |',
  '|---|---|---|',
  '| **This JSON collection** | Customer routes (Steps 1–11), many negative tests | `postman/for-after-api.postman_collection.json` |',
  '| **Postman workspace collection** | Steps 1–14 incl. release, Recipient Portal and Trusted Contact death reports | `D:\\FOR-AFTER-DIGITAL-VAULT\\postman\\collections\\FOR-AFTER` (folders 11–15) |',
  '',
  '## Use',
  '',
  '1. Start the API (`npm run start:dev`) with PostgreSQL and Redis running.',
  '2. In Postman: **Import** `for-after-api.postman_collection.json` and `for-after-local.postman_environment.json`.',
  '3. Select the **For After - Local** environment.',
  '4. Run the collection in order (**Run collection**). Requests save ids for later requests, so run folders top to bottom.',
  '5. Wait 60 s between full runs: register and login allow 5 requests per minute.',
  '',
  'Folder 07 (message media) needs object storage in `.env`. For its full happy path, set `photoSizeBytes` to the exact',
  'size of a JPEG and select that file in **Upload file to storage** (Body > binary). Without it, that request and the',
  'three after it fail; everything else still runs.',
  '',
  '`NEG -` requests are negative tests: they pass when the API rejects the request with the listed status.',
  '',
  '## Not covered',
  '',
  '- 403 for non-customer roles: there is no API to create an admin user yet.',
  '- `RELEASED` message rules (409 on edit/schedule/media): a release needs a FIXED_DATE to pass; see `test/message-release.e2e-spec.ts`.',
  '- Recipient Portal (Step 13) and Trusted Contact sign-in + death reports (Step 14): they need a one-time code from the',
  '  API console, so they live in the Postman workspace collection (folders 12–15); see `docs/recipient-portal.md` and',
  '  `docs/trusted-contact-auth.md`.',
  '- Routes listed in `docs/api.md` that are not implemented yet (2FA, email verification, password reset, users,',
  '  death verification review, subscriptions, webhooks).',
  '',
];
let total = 0;
let negatives = 0;
for (const f of folders) {
  md.push(`## ${f.name}`, '');
  if (f.description) md.push(f.description, '');
  md.push('| # | Test | Method | Path | Expect |', '| --: | :-- | :-- | :-- | :-- |');
  f.items.forEach((req, i) => {
    total++;
    if (req.name.startsWith('NEG')) negatives++;
    const path = (req.url ?? `{{baseUrl}}${req.path}`).replace('{{baseUrl}}', '') || '/';
    const expect = req.msg ? `${req.status} \`${req.msg}\`` : String(req.status);
    md.push(`| ${i + 1} | ${req.name.replace(/\|/g, '\\|')} | ${req.method} | \`${path}\` | ${expect} |`);
  });
  md.push('');
}
md.splice(4, 0, `${total} requests: ${total - negatives} positive, ${negatives} negative.`, '');

writeFileSync(join(here, 'for-after-api.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
writeFileSync(join(here, 'for-after-local.postman_environment.json'), JSON.stringify(environment, null, 2) + '\n');
writeFileSync(join(here, 'README.md'), md.join('\n'));
console.log(`${total} requests (${negatives} negative) in ${folders.length} folders`);
