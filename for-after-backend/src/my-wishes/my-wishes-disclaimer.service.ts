import { ConflictException, Injectable } from '@nestjs/common';
import { writeAuditLog } from '../audit/audit-log.service.js';
import {
  AuditActorType,
  AuditEventType,
  Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The My Wishes notice, version 1. Approved by the product owner on
 * 2026-10-08 (Phase 15A); formal legal review is a separate, open item.
 * Changing a word of it means a new version (and Customers acknowledge
 * again before their next write).
 */
export const MY_WISHES_DISCLAIMER_V1 =
  'My Wishes records personal preferences and guidance only. It is not a will, legal document, medical directive, financial instruction or substitute for professional advice.';

/** The current notice. A provider, so tests can swap in another version. */
@Injectable()
export class MyWishesDisclaimer {
  readonly version: number = 1;
  readonly text: string = MY_WISHES_DISCLAIMER_V1;
}

export const DISCLAIMER_NOT_ACKNOWLEDGED =
  'Please acknowledge the current My Wishes notice before saving.';
export const DISCLAIMER_OUTDATED =
  'The My Wishes notice has changed. Please read the current version.';

export type DisclaimerStatus = {
  version: number;
  text: string;
  requiresAcknowledgement: true;
  acknowledged: boolean;
  acknowledgedAt: Date | null;
};

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Phase 15A (approved policy): the backend is the only source of the notice;
 * a Customer acknowledges it once per version before creating or editing
 * wishes (enforced here, not by the UI). Reading and deleting never need it.
 * An acknowledgement is a record that this version was shown and confirmed,
 * nothing more: never consent, a waiver or legal advice. Rows are kept as
 * history; existing users have none until they acknowledge.
 */
@Injectable()
export class MyWishesDisclaimerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly disclaimer: MyWishesDisclaimer,
  ) {}

  private acknowledgement(db: Db, userId: string) {
    return db.myWishesDisclaimerAcknowledgement.findUnique({
      where: {
        userId_disclaimerVersion: {
          userId,
          disclaimerVersion: this.disclaimer.version,
        },
      },
      select: { acknowledgedAt: true },
    });
  }

  // The session user's own state only.
  async status(userId: string): Promise<DisclaimerStatus> {
    const ack = await this.acknowledgement(this.prisma, userId);
    return {
      version: this.disclaimer.version,
      text: this.disclaimer.text,
      requiresAcknowledgement: true,
      acknowledged: !!ack,
      acknowledgedAt: ack?.acknowledgedAt ?? null,
    };
  }

  /**
   * Idempotent, safe under concurrent requests: the unique (user, version)
   * row is created at most once (skipDuplicates) and only that first time
   * writes the audit event. Only the current version can be acknowledged.
   */
  async acknowledge(
    userId: string,
    version: number,
  ): Promise<DisclaimerStatus> {
    if (version !== this.disclaimer.version) {
      throw new ConflictException(DISCLAIMER_OUTDATED);
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.myWishesDisclaimerAcknowledgement.createMany({
        data: [{ userId, disclaimerVersion: version }],
        skipDuplicates: true,
      });
      if (count) {
        await writeAuditLog(tx, {
          eventType: AuditEventType.MY_WISHES_DISCLAIMER_ACKNOWLEDGED,
          // Data-minimised: no IP or device, the version only.
          actor: { type: AuditActorType.CUSTOMER, userId },
          subjectType: 'User',
          subjectId: userId,
          metadata: { disclaimerVersion: version },
        });
      }
    });
    return this.status(userId);
  }

  /** Before any wish is created or changed: 409 without a current acknowledgement. */
  async assertAcknowledged(userId: string, db: Db = this.prisma) {
    if (!(await this.acknowledgement(db, userId))) {
      throw new ConflictException(DISCLAIMER_NOT_ACKNOWLEDGED);
    }
  }
}
