'use client';

import { CheckCircle2, Clock3, Info, ShieldBan, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, DataTable, linkClass, Pager, Panel, SelectField, useFilterNav } from '@/components/admin/admin-ui';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { TextAreaField, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useCreateIpBlock, useIpBlocks, useRevokeIpBlock } from '@/hooks/use-admin';
import { IP_BLOCK_STATUSES, type IpBlock, type IpBlockControls, type IpBlockFilters, type IpBlockStatus } from '@/lib/api/admin';
import { formatTimestamp } from '@/lib/format';

const BASE = '/admin/security/ip-blocks';
const REASON_MAX = 500;
const DURATIONS = [
  { value: '15', label: '15 minutes' },
  { value: '60', label: '1 hour' },
  { value: '1440', label: '24 hours' },
];
export const UNAVAILABLE = 'IP blocking is unavailable for this source.';

const STATUS: Record<IpBlockStatus, { label: string; tone: 'danger' | 'neutral'; Icon: typeof ShieldBan }> = {
  active: { label: 'Active', tone: 'danger', Icon: ShieldBan },
  expired: { label: 'Expired', tone: 'neutral', Icon: Clock3 },
  revoked: { label: 'Revoked', tone: 'neutral', Icon: ShieldOff },
};

const StatusBadge = ({ status }: { status: IpBlockStatus }) => {
  const { label, tone, Icon } = STATUS[status];
  return (
    <Badge tone={tone} className="gap-1">
      <Icon aria-hidden strokeWidth={1.75} className="size-3.5" />
      {label}
    </Badge>
  );
};

/** Opened only by its button. Nothing is created until Confirm, and success is shown only after the API saved it. */
function BlockIpDialog({ onCreated }: { onCreated: (block: IpBlock) => void }) {
  const create = useCreateIpBlock();
  const [ip, setIp] = useState('');
  const [duration, setDuration] = useState('60');
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog
      trigger={<Button variant="outline">Block IP</Button>}
      title="Block IP temporarily"
      description="Enter one exact address you have reviewed. Masked networks and ranges can’t be blocked."
      confirmLabel="Confirm temporary block"
      tone="default"
      pending={create.isPending}
      error={create.error}
      confirmDisabled={!ip.trim() || !reason.trim()}
      onOpenChange={(open) => {
        if (open) return;
        create.reset();
        setIp('');
        setDuration('60');
        setReason('');
      }}
      onConfirm={() => create.mutateAsync({ ip: ip.trim(), durationMinutes: Number(duration), reason: reason.trim() }).then(onCreated)}
    >
      <div className="grid gap-4">
        <TextField id="block-ip" label="IP address" spellCheck={false} autoComplete="off" className="font-mono" maxLength={64} value={ip} onChange={(e) => setIp(e.target.value)} />
        <SelectField id="block-duration" label="Duration" value={duration} options={DURATIONS} onChange={(e) => setDuration(e.target.value)} />
        <TextAreaField
          id="block-reason"
          label="Reason"
          rows={2}
          maxLength={REASON_MAX}
          length={reason.length}
          hint="Say what you reviewed. Don’t include personal details."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <ul className="grid list-disc gap-1.5 rounded-lg bg-surface-muted py-3 pr-4 pl-8 text-sm text-foreground-secondary">
          <li>
            <strong className="font-medium">Scope:</strong> the customer app, portals, admin portal and API. Health checks
            and the signed Stripe webhook are not affected.
          </li>
          <li>
            <strong className="font-medium">Effect:</strong> new requests from this address get a 403 until the block ends.
            Signed-in sessions aren’t ended, but they can’t be used from this address. Other API instances apply it within
            15 seconds.
          </li>
          <li>
            <strong className="font-medium">Shared networks:</strong> an office, mobile carrier or VPN can put many people
            on one address. They’re all blocked, whoever caused the activity.
          </li>
        </ul>
      </div>
    </ConfirmDialog>
  );
}

const Created = ({ block }: { block: IpBlock }) => (
  <p role="status" className="flex items-start gap-2 rounded-lg bg-success/10 px-4 py-3 text-sm text-success">
    <CheckCircle2 aria-hidden strokeWidth={1.75} className="mt-0.5 size-4 shrink-0" />
    <span>
      <span className="font-mono">{block.ip}</span> is blocked until {formatTimestamp(block.expiresAt)}.
    </span>
  </p>
);

/** Who can do what, in words, instead of a control that fails. */
function ManageNote({ controls }: { controls: IpBlockControls }) {
  if (!controls.available) return null;
  if (!controls.superAdmin) return <p className="text-sm text-foreground-muted">Only a super admin can block or revoke an address.</p>;
  if (!controls.recentAuth) return <p className="text-sm text-foreground-muted">Sign in again with two-factor to block or revoke an address.</p>;
  return null;
}

export function IpControlsPanel({ sources, sourcesTrusted }: { sources: { network: string; count: number }[]; sourcesTrusted: boolean }) {
  const blocks = useIpBlocks({ page: 1, status: 'active' });
  const [created, setCreated] = useState<IpBlock | null>(null);
  const controls = blocks.data?.controls;
  return (
    <Panel title="IP controls" className="content-start gap-4 sm:p-6">
      <p className="-mt-2 text-sm text-foreground-muted">Temporary blocks for exact, reliably attributed addresses only.</p>
      {created && <Created block={created} />}
      {blocks.isError && !controls ? (
        <p role="alert" className="rounded-md bg-danger/8 px-4 py-3 text-sm text-danger">
          IP controls couldn’t be loaded. Block status is unknown; this doesn’t mean none are active.
        </p>
      ) : (
        controls && (
          <>
            {!controls.available && (
              <p className="rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
                <strong className="font-medium">{UNAVAILABLE}</strong> This deployment’s proxy chain hasn’t been verified,
                so addresses can’t be blocked and no block is being enforced.
              </p>
            )}
            <dl className="flex items-baseline justify-between gap-3 border-b border-border pb-4">
              <dt className="text-sm text-foreground-secondary">Active temporary blocks</dt>
              <dd className="font-heading text-3xl leading-none tabular-nums">{controls.activeCount.toLocaleString('en-AU')}</dd>
            </dl>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Link href={BASE} className={`text-sm ${linkClass}`}>
                Manage temporary blocks
              </Link>
              {controls.available && controls.superAdmin && controls.recentAuth && <BlockIpDialog onCreated={setCreated} />}
            </div>
            <ManageNote controls={controls} />
          </>
        )
      )}
      <section aria-labelledby="source-activity" className="grid gap-3 border-t border-border pt-4">
        <h3 id="source-activity" className="font-sans text-sm font-medium tracking-normal">
          Recorded source activity
        </h3>
        {sources.length === 0 ? (
          <p className="text-sm text-foreground-muted">No source networks were recorded on these events in this period.</p>
        ) : (
          <ul className="grid gap-3">
            {sources.map((s) => (
              <li key={s.network} className="grid gap-0.5 text-sm">
                <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-mono break-all">{s.network}</span>
                  <span className="text-foreground-muted tabular-nums">
                    {s.count.toLocaleString('en-AU')} {s.count === 1 ? 'row' : 'rows'}
                  </span>
                </span>
                <span className="text-xs text-foreground-muted">
                  {sourcesTrusted ? 'Masked network · trusted attribution' : 'Masked network · proxy attribution unverified'}
                </span>
                <span className="text-xs text-foreground-muted">{UNAVAILABLE}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="flex gap-2 text-xs text-foreground-muted">
          <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Only masked networks are stored, so no row can become a block target. These are audit rows, not requests.
            Automated abuse detection is unavailable, and appearing here doesn’t show a network did anything wrong.
          </span>
        </p>
      </section>
    </Panel>
  );
}

function RevokeButton({ block }: { block: IpBlock }) {
  const revoke = useRevokeIpBlock();
  return (
    <ConfirmDialog
      trigger={<Button variant="outline" size="sm">Revoke</Button>}
      title="Revoke this block?"
      description={
        <>
          Requests from <span className="font-mono">{block.ip ?? block.network}</span> will be allowed again, within 15
          seconds on every API instance. The record of this block stays.
        </>
      }
      confirmLabel="Revoke block"
      tone="default"
      pending={revoke.isPending}
      error={revoke.error}
      onOpenChange={(open) => !open && revoke.reset()}
      onConfirm={() => revoke.mutateAsync(block.id)}
    />
  );
}

export function IpBlockList({ filters }: { filters: IpBlockFilters }) {
  const list = useIpBlocks(filters);
  const nav = useFilterNav(BASE, filters);
  const [created, setCreated] = useState<IpBlock | null>(null);
  const controls = list.data?.controls;
  const canManage = !!controls && controls.superAdmin && controls.recentAuth;
  return (
    <>
      <PageHeader
        back={{ href: '/admin/security', label: 'Security activity' }}
        title="Temporary IP blocks"
        description="Active blocks and the record of expired and revoked ones."
        action={controls?.available && canManage ? <BlockIpDialog onCreated={setCreated} /> : undefined}
      />
      <div className="grid gap-6">
        {created && <Created block={created} />}
        {controls && !controls.available && (
          <p className="rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
            <strong className="font-medium">{UNAVAILABLE}</strong> This deployment’s proxy chain hasn’t been verified, so no
            block on this list is being enforced.
          </p>
        )}
        {controls && <ManageNote controls={controls} />}
        <div className="max-w-xs">
          <SelectField
            id="status"
            label="Status"
            value={filters.status ?? ''}
            onChange={(e) => nav.set({ status: (e.target.value || undefined) as IpBlockStatus | undefined })}
            options={[{ value: '', label: 'All' }, ...IP_BLOCK_STATUSES.map((s) => ({ value: s, label: STATUS[s].label }))]}
          />
        </div>
        <QueryView query={list} loadingLabel="Loading temporary blocks">
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState icon={ShieldBan} title={filters.status ? 'No temporary blocks with this status' : 'No temporary blocks yet'} />
            ) : (
              <div>
                <DataTable
                  caption="Temporary IP blocks"
                  rows={data.items}
                  rowKey={(b) => b.id}
                  columns={[
                    {
                      header: 'IP',
                      cell: (b) =>
                        b.ip ? (
                          <span className="font-mono text-sm">{b.ip}</span>
                        ) : (
                          <span>
                            <span className="font-mono text-sm">{b.network}</span>
                            <span className="block text-xs text-foreground-muted">Masked for your role</span>
                          </span>
                        ),
                    },
                    { header: 'Reason', cell: (b) => b.reason ?? <span className="text-foreground-muted">Super admins only</span> },
                    { header: 'Created by', cell: (b) => b.createdByName ?? '—' },
                    { header: 'Created', cell: (b) => <span className="whitespace-nowrap">{formatTimestamp(b.createdAt)}</span> },
                    { header: 'Expiry', cell: (b) => <span className="whitespace-nowrap">{formatTimestamp(b.expiresAt)}</span> },
                    {
                      header: 'Status',
                      cell: (b) => (
                        <span className="grid gap-1">
                          <StatusBadge status={b.status} />
                          {b.revokedAt && (
                            <span className="text-xs text-foreground-muted">
                              {formatTimestamp(b.revokedAt)}
                              {b.revokedByName && ` by ${b.revokedByName}`}
                            </span>
                          )}
                        </span>
                      ),
                    },
                    { header: 'Action', cell: (b) => (canManage && b.status === 'active' ? <RevokeButton block={b} /> : '—') },
                  ]}
                />
                <Pager pagination={data.pagination} hrefFor={(page) => nav.href({ page })} />
              </div>
            )
          }
        </QueryView>
      </div>
    </>
  );
}
