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
  wishes            Wishes?
  subscription      Subscription?
  storageUsage      StorageUsage?
}

model Recipient {
  id              String    @id @default(uuid())
  userId          String
  firstName       String
  lastName        String
  relationship    String?
  email           String?
  mobile          String?
  photoUrl        String?
  photoAssetId    String?
  privateNote     String?
  status          String    @default("ACTIVE")
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  
  user            User      @relation(fields: [userId], references: [id])
  messageRecipients MessageRecipient[]
}

model TrustedContact {
  id               String    @id @default(uuid())
  userId           String
  recipientId      String?
  name             String
  email            String
  mobile           String?
  status           String    @default("PENDING")
  invitationSentAt DateTime?
  acceptedAt       DateTime?
  revokedAt        DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
}

model Message {
  id          String        @id @default(uuid())
  userId      String
  title       String
  description String?
  type        MessageType
  status      MessageStatus @default(DRAFT)
  deletedAt   DateTime?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt

  user        User          @relation(fields: [userId], references: [id])
  recipients  MessageRecipient[]
  schedules   ReleaseSchedule[]
}

model MessageRecipient {
  id          String    @id @default(uuid())
  messageId   String
  recipientId String
  releasedAt  DateTime?
  revokedAt   DateTime?

  message     Message   @relation(fields: [messageId], references: [id])
  recipient   Recipient @relation(fields: [recipientId], references: [id])
  
  @@unique([messageId, recipientId])
}

model ReleaseSchedule {
  id             String      @id @default(uuid())
  messageId      String
  releaseType    ReleaseType
  releaseAt      DateTime?
  relativeAmount Int?
  relativeUnit   String?
  recurrenceRule String?
  timezone       String?
  state          String      @default("PENDING")
  active         Boolean     @default(true)
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt

  message        Message     @relation(fields: [messageId], references: [id])
}

model Delivery {
  id                 String    @id @default(uuid())
  releaseScheduleId  String
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

model MediaFile {
  id               String    @id @default(uuid())
  ownerId          String
  messageId        String?
  memoryId         String?
  provider         String
  providerAssetId  String?
  objectKey        String?
  storageKey       String?
  mediaType        String?
  mimeType         String
  fileSize         BigInt?
  durationSeconds  Int?
  processingStatus String?
  checksum         String?
  status           String    @default("ACTIVE")
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
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

enum MessageType {
  VIDEO
  AUDIO
  TEXT
  PHOTO
  MIXED
}

enum MessageStatus {
  DRAFT
  SCHEDULED
  RELEASED
  CANCELLED
}

enum ReleaseType {
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
    Message ||--o{ ReleaseSchedule : triggered-by
    ReleaseSchedule ||--o{ Delivery : creates
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
