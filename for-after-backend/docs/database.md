# 🗄️ For After — Database Design

> The PostgreSQL schema (Prisma 7): every model, enum and relationship, with notes on what is built and what is planned.

| | |
|---|---|
| **Built** | 16 migrations through Step 16 (latest: `add_admin_backend_security_audit`, additive only) |
| **Source of truth** | `prisma/schema.prisma` (this doc explains it; the schema file wins if they differ) |
| **Related** | [Architecture](architecture.md) · [Authorization](authorization.md) · [Death verification](death-verification.md) |

## 🧭 Contents

1. [Database selection](#1-database-selection)
2. [Complete Prisma schema](#2-complete-prisma-schema)
3. [Enums](#3-enums)
4. [Entity relationship diagram](#4-entity-relationship-diagram)
5. [Indexing strategy](#5-indexing-strategy)
6. [Row-level security](#6-row-level-security-rls)
7. [Migration strategy](#7-migration-strategy)
8. [Connection configuration](#8-connection-configuration)

---

## 1. Database Selection
**PostgreSQL 16** is chosen as the primary database. Key reasons:
- **ACID Transactions**: Critical for maintaining consistency during complex workflows like death verification and Stripe billing updates.
- **Row-Level Security (RLS)**: Essential for strong tenant (user) data isolation.
- **Relational Integrity**: Foreign keys ensure consistency across complex entity graphs (e.g., User -> Message -> Recipient).
- **JSONB Support**: Allows flexible schema-less data storage for features like audit metadata while retaining indexing and relational guarantees. (My Wishes, Step 11, uses a normal table instead: one text answer per prompt.)

## 2. Complete Prisma Schema

```prisma
// schema.prisma snippet representation

model User {
  id                String    @id @default(uuid())
  email             String    @unique
  passwordHash      String
  firstName         String
  lastName          String
  role              UserRole  @default(CUSTOMER)
  status            UserStatus @default(ACTIVE)
  emailVerifiedAt   DateTime?
  twoFactorEnabled  Boolean   @default(false)
  passedAt          DateTime?
  passwordChangedAt DateTime? // Step 22: sessions signed in before this get 401
  deletedAt         DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  
  // Relations
  recipients        Recipient[]
  messages          Message[]
  mediaAssets       MediaAsset[]   // Step 7
  memoryVaultItems       MemoryVaultItem[]        // Step 9
  memoryVaultMediaAssets MemoryVaultMediaAsset[]  // Step 9
  myStoryResponses       MyStoryResponse[]        // Step 10
  myWishResponses        MyWishResponse[]         // Step 11
  adminMfaCredential    AdminMfaCredential?    // Step 16, admins only
  adminMfaRecoveryCodes AdminMfaRecoveryCode[] // Step 16, admins only
  subscription      Subscription?
  storageUsage      StorageUsage?
}

model Recipient {
  // Implemented in Step 3 (People I Love). Owned contact record, NOT a login account:
  // no password, role, status, OTP or session. Recipient Portal access (Step 13)
  // uses RecipientMessageAccessGrant snapshots, never this row's live email.
  id           String    @id @default(uuid()) @db.Uuid
  ownerUserId  String    @db.Uuid
  firstName    String
  lastName     String?
  relationship String?   // free text, no enum yet
  email        String?   // lowercased, NOT unique (several customers may add the same person)
  mobile       String?   // stored as typed, not verified
  birthday     DateTime? @db.Date   // calendar date, no timezone
  privateNote  String?   // owner-only, max 2000 chars, never logged
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  deletedAt    DateTime? // soft delete; future messages will reference recipients

  owner        User      @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  messageRecipients MessageRecipient[] // Step 5
  // Planned: photo (Media step).
  // Planned: a person may be both a Recipient and a TrustedContact (e.g. a spouse);
  // the two tables stay independent until that overlap is designed.
  @@index([ownerUserId])
}

model TrustedContact {
  // Implemented in Step 4. Owned contact record, NOT a User: no password, role or
  // status columns. Step 14 adds email OTP sign-in (Redis sessions only, nothing
  // stored here) and death reports (docs/trusted-contact-auth.md). Being a trusted
  // contact grants NO access to the owner's content (messages, media, vault,
  // story, wishes).
  id           String    @id @default(uuid()) @db.Uuid
  ownerUserId  String    @db.Uuid
  firstName    String
  lastName     String?
  relationship String?   // free text, no enum yet
  email        String?   // lowercased, NOT unique (one person may serve several customers)
  mobile       String?   // stored as typed, not verified
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  deletedAt    DateTime? // soft delete; submitted DeathReports stay as history

  owner        User      @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  deathReports DeathReport[]                     // Step 14
  @@index([ownerUserId])
  @@index([email])                               // Step 14: OTP eligibility + account lookup
  // DB CHECK "TrustedContact_contact_method_check": email IS NOT NULL OR mobile IS NOT NULL
  // (hand-written in the add_trusted_contacts migration).
  // Planned: status/invitation fields (TC auth step), permissions (product decision),
  // and a possible link to Recipient for people who are both (e.g. a spouse);
  // for now the two tables are independent and not deduplicated by email.
}

model Message {
  // Implemented in Step 5. Private content owned by one customer, always created
  // DRAFT; status is server-controlled (Step 12 release worker sets RELEASED).
  // Only DRAFT may be edited or deleted. Step 6: DRAFT -> SCHEDULED only by creating
  // its schedule, SCHEDULED -> DRAFT only by deleting it. Step 8: rich composition;
  // a DRAFT may be incomplete, scheduling requires a complete one
  // (docs/message-composition.md). Media lives only in MediaAsset (no URL fields).
  // Step 12: SCHEDULED -> RELEASED only by the release worker (FIXED_DATE), with
  // a MessageRelease row in the same transaction. RELEASED is read-only (409).
  id          String             @id @default(uuid()) @db.Uuid
  ownerUserId String             @db.Uuid   // from the session only, never the request body
  title       String             // 1-200 chars
  contentType MessageContentType @default(TEXT)  // user's explicit intent: TEXT | PHOTO | AUDIO | MIXED (VIDEO reserved); never inferred
  textContent String?            // plain user text, max 20,000 (product-configurable), blank stored as null, never logged
  status      MessageStatus      @default(DRAFT)
  createdAt   DateTime           @default(now())
  updatedAt   DateTime           @updatedAt
  deletedAt   DateTime?          // soft delete; assignments are kept

  owner       User               @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  recipients  MessageRecipient[] // at least one, enforced by the API
  schedule    MessageSchedule?   // Step 6; at most one
  mediaAssets MediaAsset[]       // Step 7; changeable only while DRAFT
  release     MessageRelease?    // Step 12; at most one
  @@index([ownerUserId])
  @@index([ownerUserId, status])
}

model MessageRecipient {
  // Implemented in Step 5. "This message is intended for this Recipient", NOT
  // "this Recipient may read it now". The Recipient must belong to the same
  // owner and not be deleted at assignment time; the API checks this (the
  // database cannot). The unique pair prevents duplicate assignment, and its
  // leading column also serves messageId lookups.
  id          String    @id @default(uuid()) @db.Uuid
  messageId   String    @db.Uuid
  recipientId String    @db.Uuid
  createdAt   DateTime  @default(now())

  message     Message   @relation(fields: [messageId], references: [id], onDelete: Cascade)
  recipient   Recipient @relation(fields: [recipientId], references: [id], onDelete: Cascade)
  // Planned: releasedAt / revokedAt (Delivery step).
  @@unique([messageId, recipientId])
  @@index([recipientId])
}

// SECURITY RULE for the future recipient API: a message is visible to a recipient
// only when Message.status = RELEASED AND a MessageRecipient row links them
// (and the message is not deleted). DRAFT content must never reach a Recipient.

model MessageSchedule {
  // Implemented in Step 6. One release policy per message. PostgreSQL is the
  // source of truth (never Redis-only, never an in-process timer); Step 12
  // executes FIXED_DATE via BullMQ (docs/message-release.md); ON_DEATH and
  // AFTER_DEATH run only via a Step 15 DeathTriggeredMessageActivation of a
  // VERIFIED case (scheduledFor stays FIXED_DATE-only). Hard-deleted on
  // unschedule; kept after release.
  // Not duplicated per Recipient: per-recipient resolution (e.g. BIRTHDAY) will
  // live in future ReleaseOccurrence/Delivery rows.
  id             String             @id @default(uuid()) @db.Uuid
  messageId      String             @unique @db.Uuid
  triggerType    ReleaseTriggerType // API accepts FIXED_DATE, ON_DEATH, AFTER_DEATH only
  scheduledFor   DateTime?          // FIXED_DATE only; UTC instant, must be in the future when set
  afterDeathDays Int?               // AFTER_DEATH only; 0-36,500 (API limit, product-configurable)
  createdAt      DateTime           @default(now())
  updatedAt      DateTime           @updatedAt

  message        Message            @relation(fields: [messageId], references: [id], onDelete: Cascade)
  // DB CHECK "MessageSchedule_trigger_fields_check" (hand-written in add_message_schedules):
  // FIXED_DATE => scheduledFor set, afterDeathDays null; ON_DEATH => both null;
  // AFTER_DEATH => scheduledFor null, afterDeathDays >= 0. Any other trigger is refused
  // until a migration widens the check on purpose.
}

model MessageRelease {
  // Implemented in Step 12 (docs/message-release.md). Durable evidence that a
  // Message reached RELEASED, written in the same transaction as the status
  // change. Release is NOT delivery: nothing is sent, no content, recipient data
  // or URLs are copied here. Server-written only; never accepted from clients.
  id           String             @id @default(uuid()) @db.Uuid
  messageId    String             @unique @db.Uuid  // one release per message: retries/races cannot duplicate
  triggerType  ReleaseTriggerType // copied from the executed schedule (FIXED_DATE in Step 12)
  scheduledFor DateTime?          // copied from the executed schedule
  releasedAt   DateTime           // server time of the release
  createdAt    DateTime           @default(now())
  updatedAt    DateTime           @updatedAt

  message      Message            @relation(fields: [messageId], references: [id], onDelete: Cascade)
  accessGrants RecipientMessageAccessGrant[]  // Step 13, written in the same transaction
}

model RecipientMessageAccessGrant {
  // Implemented in Step 13 (docs/recipient-portal.md). Post-release authorization:
  // "this released Message was released to this Recipient, at these contact
  // details". One per live assigned Recipient, created in the release transaction.
  // Frozen: later Recipient edits/soft deletes do not move or revoke it. Contact
  // details only (no notes, birthday, relationship). Internal; never returned.
  id                        String         @id @default(uuid()) @db.Uuid
  messageReleaseId          String         @db.Uuid  // onDelete: Cascade
  messageId                 String         @db.Uuid  // onDelete: Cascade
  recipientId               String         @db.Uuid  // onDelete: Cascade (hard delete only via account deletion)
  recipientEmailNormalized  String?        // trimmed + lowercased at release; used by email OTP
  recipientMobileNormalized String?        // as stored, trimmed; SMS OTP deferred
  createdAt                 DateTime       @default(now())

  @@unique([messageReleaseId, recipientId]) // retries cannot duplicate
  @@index([messageId])
  @@index([recipientId])
  @@index([recipientEmailNormalized])
  @@index([recipientMobileNormalized])
}

model Delivery {
  // Planned (release step). Per-recipient release/delivery records, created by the
  // future release engine from a MessageSchedule.
  id                 String    @id @default(uuid())
  messageScheduleId  String
  recipientId        String
  idempotencyKey     String    @unique
  dueAt              DateTime
  releasedAt         DateTime?
  notificationStatus String    @default("PENDING")
  deliveryStatus     String    @default("PENDING")
  retryCount         Int       @default(0)
  lastError          String?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
}

model MemoryVaultItem {
  // Implemented in Step 9 (docs/memory-vault.md). Private customer content,
  // NOT a Message: no status, contentType, recipients, schedule or release.
  id          String              @id @default(uuid()) @db.Uuid
  ownerUserId String              @db.Uuid  // from the session only
  title       String              // trimmed, 1-200 (Message title rule)
  category    MemoryVaultCategory // fixed enum, no custom categories
  textContent String?             // optional, max 20,000; blank stored as null
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt
  deletedAt   DateTime?           // soft delete; hides the item's media too

  owner       User                    @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  mediaAssets MemoryVaultMediaAsset[]
  @@index([ownerUserId])
  @@index([ownerUserId, category])
}

model MemoryVaultMediaAsset {
  // Implemented in Step 9. Same shape, storage and lifecycle as MediaAsset,
  // attached to a Memory Vault item instead of a Message.
  id                String           @id @default(uuid()) @db.Uuid
  ownerUserId       String           @db.Uuid
  memoryVaultItemId String           @db.Uuid
  kind              MediaKind        // PHOTO | AUDIO (VIDEO reserved)
  status            MediaAssetStatus @default(PENDING_UPLOAD)
  storageKey        String           @unique   // users/{owner}/memory-vault/{item}/{id}.{ext}; never returned
  originalFileName  String
  mimeType          String
  sizeBytes         Int
  uploadedAt        DateTime?
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt
  deletedAt         DateTime?

  owner             User            @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  memoryVaultItem   MemoryVaultItem @relation(fields: [memoryVaultItemId], references: [id], onDelete: Cascade)
  @@index([ownerUserId])
  @@index([memoryVaultItemId, status])   // also serves memoryVaultItemId lookups
  // DB CHECK "MemoryVaultMediaAsset_kind_size_check": kind IN (PHOTO, AUDIO) AND sizeBytes > 0.
}

model MediaAsset {
  // Implemented in Step 7. A PHOTO or AUDIO file attached to a customer's own
  // message. Bytes live in a PRIVATE S3-compatible bucket (Backblaze B2 in
  // development) and never pass through the API; see docs/media-storage.md.
  id               String           @id @default(uuid()) @db.Uuid
  ownerUserId      String           @db.Uuid  // from the session only
  messageId        String           @db.Uuid  // route param, after the ownership check
  kind             MediaKind        // PHOTO | AUDIO (VIDEO reserved)
  status           MediaAssetStatus @default(PENDING_UPLOAD) // -> READY | FAILED, server-controlled
  storageKey       String           @unique   // users/{owner}/messages/{message}/{id}.{ext}; server-generated, never returned
  originalFileName String           // metadata only (max 255), never used as a path
  mimeType         String           // allowlisted per kind
  sizeBytes        Int              // expected size, checked with HEAD before READY
  uploadedAt       DateTime?        // set when verified READY
  createdAt        DateTime         @default(now())
  updatedAt        DateTime         @updatedAt
  deletedAt        DateTime?        // soft delete; object removal is best-effort afterwards

  owner            User             @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  message          Message          @relation(fields: [messageId], references: [id], onDelete: Cascade)
  @@index([ownerUserId])
  @@index([messageId, status])     // also serves messageId lookups
  // DB CHECK "MediaAsset_kind_size_check": kind IN (PHOTO, AUDIO) AND sizeBytes > 0.
  // Signed URLs are never stored. Planned: VIDEO via a streaming provider,
  // duration/checksum/scan status, StorageUsage quotas.
}

model DeathVerificationCase {
  // Step 14 intake + Step 15 workflow (docs/death-verification.md). One canonical
  // case per Customer. Report → safety notice → safeguard → READY_FOR_REVIEW →
  // admin VERIFIED / REJECTED, or CANCELLED by the Customer. Only VERIFIED
  // activates death triggers; the verify transaction also sets User.status=PASSED.
  id                        String                      @id @default(uuid()) @db.Uuid
  ownerUserId               String                      @unique @db.Uuid
  status                    DeathVerificationCaseStatus @default(PENDING_VERIFICATION)
  openedAt                  DateTime                    @default(now())
  resolvedAt                DateTime?                   // set with every terminal status
  safetyNoticeSentAt        DateTime?                   // safeguard starts only after a successful send
  safetyNoticeLastAttemptAt DateTime?
  safetyNoticeAttemptCount  Int                         @default(0)
  safeguardStartedAt        DateTime?
  safeguardEndsAt           DateTime?                   // stored: config changes never move a running window
  verifiedAt                DateTime?                   // when For After approved (ON_DEATH dueAt)
  verifiedDeathAt           DateTime?                   // approved time of death, UTC (AFTER_DEATH base)
  verifiedByUserId          String?                     @db.Uuid   // admin id, plain history (no FK)
  rejectedAt                DateTime?
  rejectedByUserId          String?                     @db.Uuid
  cancelledAt               DateTime?
  adminDecisionNote         String?                     // admin-only, never logged
  deathTriggersActivatedAt  DateTime?                   // activation rows built (not proof of release)
  createdAt                 DateTime                    @default(now())
  updatedAt                 DateTime                    @updatedAt

  owner       User                              @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  reports     DeathReport[]
  auditEvents DeathVerificationAuditEvent[]
  activations DeathTriggeredMessageActivation[]
  @@index([status])
}

model DeathVerificationAuditEvent {
  // Step 15. Append-only, written in the same transaction as the change it
  // records. Actor ids are plain history (no FK). No free text or JSON.
  id                      String                          @id @default(uuid()) @db.Uuid
  deathVerificationCaseId String                          @db.Uuid
  eventType               DeathVerificationAuditEventType
  actorType               DeathVerificationActorType      // SYSTEM, CUSTOMER, TRUSTED_CONTACT, ADMIN
  actorUserId             String?                         @db.Uuid
  actorTrustedContactId   String?                         @db.Uuid
  createdAt               DateTime                        @default(now())

  deathVerificationCase   DeathVerificationCase @relation(fields: [deathVerificationCaseId], references: [id], onDelete: Cascade)
  @@index([deathVerificationCaseId, createdAt])
}

model DeathTriggeredMessageActivation {
  // Step 15. Durable execution state for ON_DEATH / AFTER_DEATH after a VERIFIED
  // case: one row per Message (idempotent), read by the release worker.
  id                      String             @id @default(uuid()) @db.Uuid
  messageId               String             @unique @db.Uuid
  deathVerificationCaseId String             @db.Uuid
  triggerType             ReleaseTriggerType // ON_DEATH or AFTER_DEATH
  activatedAt             DateTime
  dueAt                   DateTime           // ON_DEATH: verifiedAt; AFTER_DEATH: verifiedDeathAt + afterDeathDays
  createdAt               DateTime           @default(now())
  updatedAt               DateTime           @updatedAt

  message                 Message               @relation(fields: [messageId], references: [id], onDelete: Cascade)
  deathVerificationCase   DeathVerificationCase @relation(fields: [deathVerificationCaseId], references: [id], onDelete: Cascade)
  @@index([deathVerificationCaseId])
  @@index([dueAt])
}

model DeathReport {
  // Implemented in Step 14. One per Trusted Contact per case. Reporter fields are
  // snapshots at submission; later edits to the TrustedContact never change them.
  // The TrustedContact FK cascades (like RecipientMessageAccessGrant) so deleting
  // the owner's account is not blocked; the API only soft-deletes contacts.
  id                         String    @id @default(uuid()) @db.Uuid
  deathVerificationCaseId    String    @db.Uuid
  reportedByTrustedContactId String    @db.Uuid
  reporterFirstNameSnapshot  String
  reporterLastNameSnapshot   String?
  reporterEmailNormalized    String?
  reporterMobileNormalized   String?
  reportedDateOfDeath        DateTime? @db.Date   // date only, not in the future
  note                       String?              // plain text, max 2000, never logged
  createdAt                  DateTime  @default(now())

  deathVerificationCase      DeathVerificationCase @relation(fields: [deathVerificationCaseId], references: [id], onDelete: Cascade)
  reportedByTrustedContact   TrustedContact        @relation(fields: [reportedByTrustedContactId], references: [id], onDelete: Cascade)
  @@unique([deathVerificationCaseId, reportedByTrustedContactId])
  @@index([reportedByTrustedContactId])
}

// Planned (verification step, not built): DeathDocument and DeathConfirmation below
// will reference DeathVerificationCase / DeathReport.
model DeathDocument {
  id             String   @id @default(uuid())
  deathReportId  String
  objectKey      String
  documentType   String
  uploadedBy     String
  uploadedAt     DateTime @default(now())
}

model DeathConfirmation {
  id                 String   @id @default(uuid())
  deathReportId      String
  trustedContactId   String
  decision           String
  confirmedAt        DateTime @default(now())
  metadata           Json?
}

model MyStoryResponse {
  // Implemented in Step 10 (docs/my-story.md). Replaces the earlier StoryPrompt /
  // StoryResponse draft: prompts are application content in
  // src/my-story/my-story.prompts.ts, not a table. Private customer content,
  // NOT a Message or Memory Vault item: no recipients, schedule, release or media.
  id                 String    @id @default(uuid()) @db.Uuid
  ownerUserId        String    @db.Uuid  // from the session only
  promptKey          String    // stable catalogue key, e.g. "legacy.remembered"
  promptTextSnapshot String    // copied from the catalogue on save, never returned
  promptVersion      Int       // copied from the catalogue on save
  textContent        String    // required, not blank, max 20,000; stored as written
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  deletedAt          DateTime? // soft delete; the next PUT restores the same row

  owner User @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  @@unique([ownerUserId, promptKey]) // one answer per prompt; also serves owner lookups
}

model MyWishResponse {
  // Implemented in Step 11 (docs/my-wishes.md). Replaces the earlier `Wishes`
  // JSON draft. Personal preferences and guidance only: NOT a will or any legal,
  // medical or financial instruction. Same shape and rules as MyStoryResponse;
  // prompts are application content in src/my-wishes/my-wishes.prompts.ts.
  // Private: no recipients, Trusted Contact access, schedule, release or media.
  id                 String    @id @default(uuid()) @db.Uuid
  ownerUserId        String    @db.Uuid  // from the session only
  promptKey          String    // stable catalogue key, e.g. "ceremony.style"
  promptTextSnapshot String    // copied from the catalogue on save, never returned
  promptVersion      Int       // copied from the catalogue on save
  textContent        String    // required, not blank, max 20,000; stored as written
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  deletedAt          DateTime? // soft delete; the next PUT restores the same row

  owner User @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  @@unique([ownerUserId, promptKey]) // one answer per prompt; also serves owner lookups
}

model Subscription {
  id                   String    @id @default(uuid())
  userId               String    @unique
  stripeCustomerId     String?
  stripeSubscriptionId String?
  planTier             String
  billingPeriod        String?
  status               String    @default("ACTIVE")
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt
  
  user                 User      @relation(fields: [userId], references: [id])
}

model StorageUsage {
  id         String   @id @default(uuid())
  userId     String   @unique
  bytesUsed  BigInt   @default(0)
  byteLimit  BigInt
  updatedAt  DateTime @updatedAt

  user       User     @relation(fields: [userId], references: [id])
}

// Built in Step 16 (migration add_admin_backend_security_audit). Append-only:
// a trigger rejects UPDATE and DELETE. Plain ids (no FKs) so history outlives
// accounts. ipPrefix is an IPv4 /24 or IPv6 /48, never the raw IP.
model AuditLog {
  id          String         @id @default(uuid()) @db.Uuid
  eventType   AuditEventType
  actorType   AuditActorType // ADMIN | SUPER_ADMIN | CUSTOMER (Step 22)
  actorUserId String?        @db.Uuid
  subjectType String?        // e.g. User, DeathVerificationCase, Job
  subjectId   String?
  ipPrefix    String?
  userAgent   String?        // truncated to 256
  metadata    Json?          // small scalar map; secret-like keys dropped
  createdAt   DateTime       @default(now())

  @@index([eventType])
  @@index([actorUserId])
  @@index([subjectType, subjectId])
  @@index([createdAt])
}

// Step 16: admin TOTP. Setup writes it with enabledAt null; confirm enables it.
// AES-256-GCM with ADMIN_TOTP_ENCRYPTION_KEY: "v1.<iv>.<tag>.<ciphertext>".
model AdminMfaCredential {
  id                  String    @id @default(uuid()) @db.Uuid
  userId              String    @unique @db.Uuid // cascade with User
  totpSecretEncrypted String
  enabledAt           DateTime?
  lastUsedTimeStep    BigInt?   // replay guard: only a newer step is accepted
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}

// Step 16: one-time admin recovery codes (10 per enrollment), SHA-256 only.
model AdminMfaRecoveryCode {
  id        String    @id @default(uuid()) @db.Uuid
  userId    String    @db.Uuid // cascade with User
  codeHash  String    @unique
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}
```

## 3. Enums
```prisma
// Step 16. Only the events listed here exist; no history was back-filled.
enum AuditEventType {
  ADMIN_PASSWORD_AUTH_SUCCEEDED
  ADMIN_MFA_SETUP_COMPLETED
  ADMIN_MFA_VERIFIED
  ADMIN_MFA_FAILED
  ADMIN_RECOVERY_CODE_USED
  ADMIN_LOGIN
  ADMIN_LOGOUT
  USER_SUSPENDED
  USER_REACTIVATED
  ADMIN_VIEWED_USER
  ADMIN_VIEWED_DEATH_CASE
  DEATH_VERIFICATION_VERIFIED
  DEATH_VERIFICATION_REJECTED
  FAILED_JOB_RETRIED
  PASSWORD_CHANGED // Step 22, actor CUSTOMER, subject User
}

enum AuditActorType {
  ADMIN
  SUPER_ADMIN
  CUSTOMER // Step 22: a Customer acting on their own account
}

enum DeathVerificationCaseStatus {
  // Step 14 created the enum; Step 15 added SAFEGUARD_ACTIVE and READY_FOR_REVIEW.
  // VERIFIED, REJECTED and CANCELLED are terminal.
  PENDING_VERIFICATION
  SAFEGUARD_ACTIVE
  READY_FOR_REVIEW
  VERIFIED
  REJECTED
  CANCELLED
}

enum DeathVerificationAuditEventType {
  // Step 15
  REPORT_RECEIVED
  SAFETY_NOTICE_SENT
  SAFEGUARD_STARTED
  SAFEGUARD_ELAPSED
  CUSTOMER_CONFIRMED_ALIVE
  ADMIN_VERIFIED
  ADMIN_REJECTED
  DEATH_TRIGGER_ACTIVATION_STARTED
  DEATH_TRIGGER_ACTIVATION_COMPLETED
}

enum DeathVerificationActorType {
  // Step 15
  SYSTEM
  CUSTOMER
  TRUSTED_CONTACT
  ADMIN
}

enum UserRole {
  CUSTOMER
  ADMIN
}

enum UserStatus {
  ACTIVE
  INACTIVE
  DECEASED
}

enum MessageContentType {
  TEXT   // the only value the API accepts in Step 5
  VIDEO
  AUDIO
  PHOTO
  MIXED
}

enum MediaKind {
  PHOTO
  AUDIO
  VIDEO   // reserved: the Step 7 API rejects it
}

enum MediaAssetStatus {
  PENDING_UPLOAD
  READY
  FAILED
}

enum MemoryVaultCategory {
  // Step 9: fixed list, no custom categories.
  FAMILY
  TRAVEL
  CHILDHOOD
  FUNNY_STORIES
  LIFE_LESSONS
  RECIPES
  LOVE_STORIES
  OTHER
}

enum MessageStatus {
  DRAFT
  SCHEDULED
  RELEASED
  CANCELLED
}

enum ReleaseTriggerType {
  // Step 6 API: FIXED_DATE, ON_DEATH, AFTER_DEATH. Others reserved (docs/scheduling.md).
  NOW
  FIXED_DATE
  BIRTHDAY
  ANNIVERSARY
  CUSTOM_EVENT
  ON_DEATH
  AFTER_DEATH
  ANNUAL_AFTER_DEATH
}
```

## 4. Entity Relationship Diagram

```mermaid
erDiagram
    User ||--o{ Recipient : has
    User ||--o{ Message : authors
    User ||--o| Subscription : billing
    User ||--o| StorageUsage : limits
    Message ||--o{ MessageRecipient : targets
    Recipient ||--o{ MessageRecipient : receives
    Message ||--o| MessageSchedule : released-by
    Message ||--o| MessageRelease : released
    MessageRelease ||--o{ RecipientMessageAccessGrant : grants
    Recipient ||--o{ RecipientMessageAccessGrant : snapshot
    MessageSchedule ||--o{ Delivery : creates
    Message ||--o{ MediaAsset : attaches
    User ||--o{ MediaAsset : owns
    User ||--o{ MemoryVaultItem : keeps
    MemoryVaultItem ||--o{ MemoryVaultMediaAsset : attaches
    User ||--o{ MyStoryResponse : writes
    User ||--o{ MyWishResponse : records
    User ||--o| AdminMfaCredential : "admin TOTP"
    User ||--o{ AdminMfaRecoveryCode : "admin recovery"
```

`AuditLog` has no relations on purpose (plain actor/subject ids).

## 5. Indexing Strategy
- **Foreign Keys**: Indexes on `userId`, `messageId`, `recipientId` to speed up joins and cascade operations.
- **Unique Constraints**: Used on `email`, `userId` (1:1 relations), and composite uniqueness (e.g., `[messageId, recipientId]`).
- **Idempotency Keys**: Unique index on `Delivery.idempotencyKey` to prevent duplicate processing.

## 6. Row-Level Security (RLS)
While Prisma does not natively manage RLS policies, PostgreSQL RLS will be applied via raw SQL migrations.
- Customers can only read/write data where `userId = current_user_id()`.
- Recipients can only view `Message` records where a corresponding `MessageRecipient.releasedAt` is non-null.
  *As built (Step 13):* enforced in the application, not RLS: a `RecipientMessageAccessGrant` for the session's verified
  email + Message `RELEASED` + not deleted (`docs/recipient-portal.md`). `MessageRecipient` has no `releasedAt`.
- *As built (Step 14):* Trusted Contacts read only `TrustedContact` rows whose email is the session's verified email (not
  deleted, owner not deleted), the owner's display name, a content-exists boolean and their case status. Enforced in the
  application (`docs/trusted-contact-auth.md`).

## 7. Migration Strategy
- Managed via `Prisma Migrate` (`npx prisma migrate dev`).
- The initial baseline migration is named `init`.
- All schema changes must be accompanied by a named migration file.
- Step 16 `add_admin_backend_security_audit` is additive: two enums, three tables, and the `audit_log_append_only`
  trigger function + `AuditLog_append_only` trigger (hand-written SQL appended to the generated migration).

## 8. Connection Configuration
```env
DATABASE_URL="postgresql://user:password@localhost:5432/for_after?schema=public"
```
Configured using `@prisma/adapter-pg` with the `pg` driver for Prisma 7 compatibility.
