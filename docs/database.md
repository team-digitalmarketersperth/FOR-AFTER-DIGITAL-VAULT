# For After — Database Design

## 1. Database Selection
**PostgreSQL 16** is chosen as the primary database. Key reasons:
- **ACID Transactions**: Critical for maintaining consistency during complex workflows like death verification and Stripe billing updates.
- **Row-Level Security (RLS)**: Essential for strong tenant (user) data isolation.
- **Relational Integrity**: Foreign keys ensure consistency across complex entity graphs (e.g., User -> Message -> Recipient).
- **JSONB Support**: Allows flexible schema-less data storage for features like "My Wishes" and audit metadata while retaining indexing and relational guarantees.

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
  deletedAt         DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  
  // Relations
  recipients        Recipient[]
  messages          Message[]
  mediaAssets       MediaAsset[]   // Step 7
  wishes            Wishes?
  subscription      Subscription?
  storageUsage      StorageUsage?
}

model Recipient {
  // Implemented in Step 3 (People I Love). Owned contact record, NOT a login account:
  // no password, role, status, OTP or session. Recipient access comes later.
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
  // Implemented in Step 4. Owned contact record, NOT a login account: no password,
  // role, OTP, session or invitation yet. Being a trusted contact grants NO access
  // to the owner's content (messages, media, vault, story, wishes); any future
  // access must be authorized separately. Death reporting comes in a later step.
  id           String    @id @default(uuid()) @db.Uuid
  ownerUserId  String    @db.Uuid
  firstName    String
  lastName     String?
  relationship String?   // free text, no enum yet
  email        String?   // lowercased, NOT unique (one person may serve several customers)
  mobile       String?   // stored as typed, not verified
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  deletedAt    DateTime? // soft delete; future death reports will reference contacts

  owner        User      @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  @@index([ownerUserId])
  // DB CHECK "TrustedContact_contact_method_check": email IS NOT NULL OR mobile IS NOT NULL
  // (hand-written in the add_trusted_contacts migration).
  // Planned: status/invitation fields (TC auth step), permissions (product decision),
  // and a possible link to Recipient for people who are both (e.g. a spouse);
  // for now the two tables are independent and not deduplicated by email.
}

model Message {
  // Implemented in Step 5. Private content owned by one customer, always created
  // DRAFT; status is server-controlled (future release sets RELEASED/CANCELLED).
  // Only DRAFT may be edited or deleted. Step 6: DRAFT -> SCHEDULED only by creating
  // its schedule, SCHEDULED -> DRAFT only by deleting it. Step 8: rich composition;
  // a DRAFT may be incomplete, scheduling requires a complete one
  // (docs/message-composition.md). Media lives only in MediaAsset (no URL fields).
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
  // Implemented in Step 6. One release policy per message: stored intent only,
  // nothing executes it yet. PostgreSQL is the source of truth (never Redis-only,
  // never an in-process timer). Hard-deleted on unschedule; the Message remains.
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

model Memory {
  id          String   @id @default(uuid())
  userId      String
  title       String
  description String?
  category    String?
  categoryId  String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model MemoryCategory {
  id          String   @id @default(uuid())
  slug        String   @unique
  name        String
  description String?
  sortOrder   Int      @default(0)
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

model DeathReport {
  id                        String    @id @default(uuid())
  subjectUserId             String
  reportedByTrustedContactId String
  status                    String    @default("PENDING")
  reportedAt                DateTime  @default(now())
  waitingPeriodEndsAt       DateTime?
  adminReviewedBy           String?
  adminReviewedAt           DateTime?
  approvedAt                DateTime?
  rejectedAt                DateTime?
  rejectionReason           String?
}

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

model StoryPrompt {
  id          String   @id @default(uuid())
  category    String
  question    String
  sortOrder   Int
  active      Boolean  @default(true)
}

model StoryResponse {
  id           String   @id @default(uuid())
  userId       String
  promptId     String
  answerType   String
  textValue    String?
  mediaAssetId String?
  createdAt    DateTime @default(now())
}

model Wishes {
  id          String   @id @default(uuid())
  userId      String   @unique
  wishesData  Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  user        User     @relation(fields: [userId], references: [id])
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

model AuditLog {
  id          String   @id @default(uuid())
  actorId     String?
  actorType   String
  action      String
  entityType  String?
  entityId    String?
  metadata    Json?
  ipAddress   String?
  userAgent   String?
  createdAt   DateTime @default(now())
}
```

## 3. Enums
```prisma
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
    User ||--o| Wishes : maintains
    User ||--o| Subscription : billing
    User ||--o| StorageUsage : limits
    Message ||--o{ MessageRecipient : targets
    Recipient ||--o{ MessageRecipient : receives
    Message ||--o| MessageSchedule : released-by
    MessageSchedule ||--o{ Delivery : creates
    Message ||--o{ MediaAsset : attaches
    User ||--o{ MediaAsset : owns
```

## 5. Indexing Strategy
- **Foreign Keys**: Indexes on `userId`, `messageId`, `recipientId` to speed up joins and cascade operations.
- **Unique Constraints**: Used on `email`, `userId` (1:1 relations), and composite uniqueness (e.g., `[messageId, recipientId]`).
- **Idempotency Keys**: Unique index on `Delivery.idempotencyKey` to prevent duplicate processing.

## 6. Row-Level Security (RLS)
While Prisma does not natively manage RLS policies, PostgreSQL RLS will be applied via raw SQL migrations.
- Customers can only read/write data where `userId = current_user_id()`.
- Recipients can only view `Message` records where a corresponding `MessageRecipient.releasedAt` is non-null.

## 7. Migration Strategy
- Managed via `Prisma Migrate` (`npx prisma migrate dev`).
- The initial baseline migration is named `init`.
- All schema changes must be accompanied by a named migration file.

## 8. Connection Configuration
```env
DATABASE_URL="postgresql://user:password@localhost:5432/for_after?schema=public"
```
Configured using `@prisma/adapter-pg` with the `pg` driver for Prisma 7 compatibility.
