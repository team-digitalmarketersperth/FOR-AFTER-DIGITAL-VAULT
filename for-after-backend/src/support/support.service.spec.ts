import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AdminSupportController, SupportController } from './support.controller.js';
import { canTransition } from './support.service.js';

const ALL = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED'] as const;

describe('support', () => {
  it('guards: Customer routes need a Customer session; the inbox needs admin role + MFA', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SupportController)).toEqual([SessionAuthGuard, CustomerGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminSupportController)).toEqual([SessionAuthGuard, AdminGuard]);
  });

  it('admin transitions: any other status, except resolved only reopens', () => {
    const allowed = ALL.flatMap((from) => ALL.filter((to) => canTransition(from, to)).map((to) => `${from}→${to}`));
    expect(allowed).toEqual([
      'OPEN→IN_PROGRESS',
      'OPEN→WAITING_FOR_CUSTOMER',
      'OPEN→RESOLVED',
      'IN_PROGRESS→OPEN',
      'IN_PROGRESS→WAITING_FOR_CUSTOMER',
      'IN_PROGRESS→RESOLVED',
      'WAITING_FOR_CUSTOMER→OPEN',
      'WAITING_FOR_CUSTOMER→IN_PROGRESS',
      'WAITING_FOR_CUSTOMER→RESOLVED',
      'RESOLVED→OPEN',
    ]);
  });
});
