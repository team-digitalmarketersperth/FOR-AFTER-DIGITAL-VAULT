import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CONTACT_METHOD_REQUIRED,
  CreateTrustedContactDto,
} from './dto/create-trusted-contact.dto.js';
import { UpdateTrustedContactDto } from './dto/update-trusted-contact.dto.js';

// ownerUserId and deletedAt never leave the API.
const trustedContactSelect = {
  id: true,
  firstName: true,
  lastName: true,
  relationship: true,
  email: true,
  mobile: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TrustedContactSelect;

export type TrustedContactResponse = Prisma.TrustedContactGetPayload<{
  select: typeof trustedContactSelect;
}>;

// Same message whether the row is missing, deleted or someone else's.
const NOT_FOUND = 'Trusted contact not found.';

// Explicit field list, so nothing else from a request can reach the database.
const toData = (dto: UpdateTrustedContactDto) => ({
  firstName: dto.firstName,
  lastName: dto.lastName,
  relationship: dto.relationship,
  email: dto.email,
  mobile: dto.mobile,
});

@Injectable()
export class TrustedContactsService {
  constructor(private readonly prisma: PrismaService) {}

  // Every read and write goes through this filter: ownership is part of the
  // query itself, never checked after fetching by id alone.
  private owned(ownerUserId: string, id: string) {
    return { id, ownerUserId, deletedAt: null };
  }

  create(
    ownerUserId: string,
    dto: CreateTrustedContactDto,
  ): Promise<TrustedContactResponse> {
    return this.prisma.trustedContact.create({
      data: { ...toData(dto), firstName: dto.firstName, ownerUserId },
      select: trustedContactSelect,
    });
  }

  findAllForOwner(ownerUserId: string): Promise<TrustedContactResponse[]> {
    return this.prisma.trustedContact.findMany({
      where: { ownerUserId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: trustedContactSelect,
    });
  }

  async findOwnedById(
    ownerUserId: string,
    id: string,
  ): Promise<TrustedContactResponse> {
    const row = await this.prisma.trustedContact.findFirst({
      where: this.owned(ownerUserId, id),
      select: trustedContactSelect,
    });
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }

  // At least one contact method must remain. Clearing one is only allowed
  // while the other is set, and that condition is part of the same UPDATE,
  // so a concurrent PATCH cannot slip in between check and write. The
  // database CHECK constraint is the final backstop.
  async update(
    ownerUserId: string,
    id: string,
    dto: UpdateTrustedContactDto,
  ): Promise<TrustedContactResponse> {
    const clearsEmail = dto.email === null && dto.mobile == null;
    const clearsMobile = dto.mobile === null && dto.email == null;
    if (clearsEmail && clearsMobile) {
      throw new BadRequestException(CONTACT_METHOD_REQUIRED);
    }
    const keepsContactMethod = clearsEmail
      ? { mobile: { not: null } }
      : clearsMobile
        ? { email: { not: null } }
        : undefined;
    return this.updateOwned(ownerUserId, id, toData(dto), keepsContactMethod);
  }

  // Soft delete: future death verification will reference trusted contacts.
  async remove(ownerUserId: string, id: string): Promise<void> {
    await this.updateOwned(ownerUserId, id, { deletedAt: new Date() });
  }

  private async updateOwned(
    ownerUserId: string,
    id: string,
    data: Prisma.TrustedContactUpdateInput,
    keepsContactMethod?: Pick<
      Prisma.TrustedContactWhereInput,
      'email' | 'mobile'
    >,
  ): Promise<TrustedContactResponse> {
    try {
      return await this.prisma.trustedContact.update({
        where: { ...this.owned(ownerUserId, id), ...keepsContactMethod },
        data,
        select: trustedContactSelect,
      });
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2025'
      ) {
        throw err;
      }
      // No row matched: tell "exists but would lose its last contact method"
      // (400) apart from "not yours / missing / deleted" (404).
      const exists =
        keepsContactMethod &&
        (await this.prisma.trustedContact.count({
          where: this.owned(ownerUserId, id),
        }));
      throw exists
        ? new BadRequestException(CONTACT_METHOD_REQUIRED)
        : new NotFoundException(NOT_FOUND);
    }
  }
}
