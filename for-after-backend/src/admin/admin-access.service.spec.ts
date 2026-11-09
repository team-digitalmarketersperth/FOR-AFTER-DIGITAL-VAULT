import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AdminAccessController } from './admin.controller.js';
import { ForbiddenException } from '@nestjs/common';
import { assertCanCreateAdmins, effectivePermissions, RECENT_AUTH_MS } from './admin-access.service.js';
import { AdminAccessQueryDto, CreateAdminDto } from './dto/admin.dto.js';

describe('Admin access', () => {
  it('admin role + MFA guards; the only writes are create and resend (no role change, delete or MFA reset)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminAccessController)).toEqual([SessionAuthGuard, AdminGuard]);
    const methods = Object.getOwnPropertyNames(AdminAccessController.prototype).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['create', 'get', 'list', 'resend']);
  });

  it('creating admins: SUPER_ADMIN with two-factor in the last 15 minutes only', () => {
    const now = Date.UTC(2026, 9, 31, 12);
    expect(() => assertCanCreateAdmins('SUPER_ADMIN', now - 60_000, now)).not.toThrow();
    expect(() => assertCanCreateAdmins('SUPER_ADMIN', now - RECENT_AUTH_MS + 1, now)).not.toThrow();
    expect(() => assertCanCreateAdmins('SUPER_ADMIN', now - RECENT_AUTH_MS - 1, now)).toThrow(/sign in again/);
    expect(() => assertCanCreateAdmins('SUPER_ADMIN', undefined, now)).toThrow(ForbiddenException);
    expect(() => assertCanCreateAdmins('ADMIN', now, now)).toThrow(/Only a super admin/);
    expect(() => assertCanCreateAdmins('CUSTOMER', now, now)).toThrow(ForbiddenException);
  });

  it('create-admin body: email and names only', async () => {
    const dto = (body: object) => plainToInstance(CreateAdminDto, body);
    expect(await validate(dto({ email: 'a@example.test', firstName: 'A', lastName: 'B' }))).toHaveLength(0);
    expect(dto({ email: '  A@Example.Test ', firstName: ' A ', lastName: 'B' })).toMatchObject({ email: 'a@example.test', firstName: 'A' });
    for (const bad of [{ email: 'x', firstName: 'A', lastName: 'B' }, { email: 'a@example.test', firstName: '', lastName: 'B' }])
      expect(await validate(dto(bad))).not.toHaveLength(0);
  });

  it('effective permissions come from the enforcing rules (canManage, AdminGuard roles)', () => {
    expect(effectivePermissions('ADMIN')).toEqual({
      adminPortal: true,
      manageCustomerAccounts: true,
      manageAdminAccounts: false,
      manageSuperAdminAccounts: false,
      changeRoles: false,
    });
    expect(effectivePermissions('SUPER_ADMIN')).toEqual({
      adminPortal: true,
      manageCustomerAccounts: true,
      manageAdminAccounts: true,
      manageSuperAdminAccounts: false, // nobody manages a SUPER_ADMIN: the last one cannot be locked out
      changeRoles: false,
    });
  });

  it('query validation: admin roles, statuses, MFA states and sort fields only', async () => {
    const q = (body: object) => plainToInstance(AdminAccessQueryDto, { page: 1, limit: 25, ...body });
    for (const bad of [{ role: 'CUSTOMER' }, { role: 'OWNER' }, { status: 'BANNED' }, { mfa: 'unknown' }, { sort: 'passwordHash' }, { search: 'x'.repeat(255) }])
      expect(await validate(q(bad))).not.toHaveLength(0);
    expect(await validate(q({ role: 'SUPER_ADMIN', status: 'SUSPENDED', mfa: 'not_enrolled', sort: 'email', dir: 'asc' }))).toHaveLength(0);
  });
});
