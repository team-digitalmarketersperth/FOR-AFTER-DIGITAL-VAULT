'use client';

import { AlertTriangle, CheckCircle2, Clock, HardDrive, Info, Trash2, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Badge, DataTable, Facts, linkClass, Pager, Panel, SelectField, useFilterNav } from '@/components/admin/admin-ui';
import { Snapshot } from '@/components/admin/releases';
import { TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, QueryView } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useStorageAsset, useStorageAssets } from '@/hooks/use-admin';
import {
  ASSET_KINDS,
  DELETION_STATES,
  STORAGE_ASSET_SOURCES,
  UPLOAD_STATES,
  type DeletionState,
  type StorageAsset,
  type StorageAssetFilters,
  type StoragePage,
  type UploadState,
} from '@/lib/api/admin';
import { DELETION_STATE, shortId, STORAGE_SOURCE_LABEL, UPLOAD_STATE, UUID } from '@/lib/admin';
import { formatBytes, formatDateTime, formatTimestamp, localToOffsetIso } from '@/lib/format';

const BASE = '/admin/storage';
const NOT_RECORDED = 'Not recorded';

/** What the URL holds: dates as calendar days in the viewer's timezone. */
export type StorageUrlFilters = StorageAssetFilters;

const toApi = ({ from, to, ...rest }: StorageUrlFilters): StorageAssetFilters => ({
  ...rest,
  from: from ? localToOffsetIso(from, '00:00') : undefined,
  to: to ? localToOffsetIso(to, '23:59').replace('T23:59:00', 'T23:59:59.999') : undefined,
});

const UPLOAD_ICON: Record<UploadState, LucideIcon> = { pending: Clock, ready: CheckCircle2, failed: AlertTriangle };
const DELETION_ICON: Record<DeletionState, LucideIcon | null> = { active: null, pending: Clock, confirmed: Trash2 };

const UploadBadge = ({ state }: { state: UploadState }) => {
  const Icon = UPLOAD_ICON[state];
  return (
    <Badge tone={UPLOAD_STATE[state].tone} className="gap-1">
      <Icon aria-hidden strokeWidth={1.75} className="size-3.5" />
      {UPLOAD_STATE[state].label}
    </Badge>
  );
};
const DeletionBadge = ({ state }: { state: DeletionState }) => {
  const Icon = DELETION_ICON[state];
  return (
    <Badge tone={DELETION_STATE[state].tone} className="gap-1">
      {Icon && <Icon aria-hidden strokeWidth={1.75} className="size-3.5" />}
      {DELETION_STATE[state].label}
    </Badge>
  );
};

/** Size with its confidence: only a verified upload's size was checked against storage. */
const Size = ({ a }: { a: StorageAsset }) => (
  <span className="whitespace-nowrap">
    {formatBytes(a.sizeBytes)}
    {!a.sizeVerified && <span className="block text-xs text-foreground-muted">Declared, not verified</span>}
  </span>
);

/** What this page can and cannot show, said once, plainly. */
function Coverage() {
  return (
    <aside aria-label="Monitoring coverage" className="mb-8 flex gap-3 rounded-xl bg-primary-soft p-5 text-sm text-foreground-secondary">
      <Info aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="grid gap-1">
        <p>
          Records from the six media tables: one record per stored file, so nothing is counted twice. Sizes use 1 KB =
          1,024 bytes, as customers see them. Totals come from these records, not from the storage provider, so they are
          not a storage bill.
        </p>
        <p>
          <strong>Not recorded per file:</strong> the malware-scan result, its time or reason. Files are checked while
          the upload completes; “Verified” means every check in force at the time passed, and a failed file’s reason
          (type mismatch or threat) is not stored. There is no quarantine: refused files are removed. Files the provider
          holds without a record here are not detected.
        </p>
      </div>
    </aside>
  );
}

function Summary({ data, nav }: { data: StoragePage; nav: ReturnType<typeof useFilterNav<StorageUrlFilters>> }) {
  if (!data.summary) {
    return (
      <p role="alert" className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-3 text-sm text-warning">
        <AlertTriangle aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
        Totals are unavailable right now. The list below is unaffected.
      </p>
    );
  }
  const summary = data.summary;
  const customer = STORAGE_ASSET_SOURCES.filter((s) => s !== 'DEATH_EVIDENCE');
  const total = (k: 'verifiedBytes' | 'reservedBytes' | 'pending' | 'failed' | 'deletionPending') =>
    customer.reduce((n, s) => n + summary[s][k], 0);
  const cards: [string, string, string?][] = [
    ['Verified recorded storage', formatBytes(total('verifiedBytes'))],
    ['Reserved by uploads in progress (declared)', formatBytes(total('reservedBytes'))],
    ['Awaiting upload or checks', total('pending').toLocaleString('en-AU'), nav.href({ uploadState: 'pending', page: undefined })],
    ['Failed verification', total('failed').toLocaleString('en-AU'), nav.href({ uploadState: 'failed', page: undefined })],
    ['Removal pending', total('deletionPending').toLocaleString('en-AU'), nav.href({ deletion: 'pending', page: undefined })],
  ];
  return (
    <section aria-labelledby="storage-summary" className="grid gap-3">
      <h2 id="storage-summary" className="text-base font-medium">
        Customer content (counted in storage quotas)
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map(([label, value, href]) => {
          const body = (
            <>
              <span className="font-heading text-2xl leading-none tabular-nums">{value}</span>
              <span className="text-sm break-words text-foreground-muted">{label}</span>
            </>
          );
          const box = 'flex h-full flex-col gap-2 rounded-lg border border-border bg-surface p-4';
          return (
            <li key={label}>
              {href ? (
                <Link
                  href={href}
                  className={`${box} outline-none hover:border-border-strong focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring`}
                >
                  {body}
                </Link>
              ) : (
                <div className={box}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-foreground-muted">
        Same definitions as each customer’s quota: verified = completed uploads not deleted; reserved = the declared size of
        uploads in progress. Removal pending counts deleted and failed records whose stored file is not yet confirmed
        removed. No platform-wide limit exists; each customer has their own.
      </p>
      <DataTable
        caption="Records by area"
        rows={[...STORAGE_ASSET_SOURCES]}
        rowKey={(s) => s}
        columns={[
          {
            header: 'Area',
            cell: (s) => (
              <span>
                {STORAGE_SOURCE_LABEL[s]}
                {s === 'DEATH_EVIDENCE' && <span className="block text-xs text-foreground-muted">Outside customer quotas</span>}
              </span>
            ),
          },
          { header: 'Verified', cell: (s) => summary[s].ready.toLocaleString('en-AU') },
          { header: 'Verified size', cell: (s) => formatBytes(summary[s].verifiedBytes) },
          { header: 'Awaiting', cell: (s) => summary[s].pending.toLocaleString('en-AU') },
          { header: 'Reserved (declared)', cell: (s) => formatBytes(summary[s].reservedBytes) },
          { header: 'Failed', cell: (s) => summary[s].failed.toLocaleString('en-AU') },
          { header: 'Removal pending', cell: (s) => summary[s].deletionPending.toLocaleString('en-AU') },
          { header: 'Removal recorded', cell: (s) => summary[s].deletionConfirmed.toLocaleString('en-AU') },
        ]}
      />
    </section>
  );
}

/** Read-only by design: no preview, download, delete, rescan or retry here. */
export function StorageList({ filters }: { filters: StorageUrlFilters }) {
  const list = useStorageAssets(toApi(filters));
  const nav = useFilterNav(BASE, filters);
  const filtered = Object.entries(filters).some(([k, v]) => k !== 'page' && v);
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Storage & scans"
        description="Stored-file records by reference: size, upload checks and removal state. Never the files, their names or links."
      />
      <Coverage />
      <StorageFilterForm key={JSON.stringify(filters)} filters={filters} onApply={nav.set} />
      {list.data ? (
        <div className="grid gap-6" aria-busy={list.isFetching || undefined}>
          <Snapshot
            evaluatedAt={list.data.evaluatedAt}
            fetching={list.isFetching}
            failed={list.isError}
            onRefresh={() => void list.refetch()}
            note="Read from the database only; refreshing opens, scans or changes no file."
          />
          <Summary data={list.data} nav={nav} />
          {list.data.items.length === 0 ? (
            <EmptyState
              icon={HardDrive}
              title={filtered ? 'No records match these filters' : 'No stored-file records yet'}
              action={
                filtered ? (
                  <Link href={BASE} className={linkClass}>
                    Clear filters
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <div>
              <DataTable
                caption="Stored-file records"
                rows={list.data.items}
                rowKey={(a) => a.reference}
                columns={[
                  {
                    header: 'Reference',
                    cell: (a) => (
                      <Link href={`${BASE}/${a.reference}`} className={`font-mono text-sm ${linkClass}`} aria-label={`Record ${a.reference}`}>
                        {shortId(a.reference)}
                      </Link>
                    ),
                  },
                  { header: 'Area', cell: (a) => STORAGE_SOURCE_LABEL[a.source] },
                  { header: 'Type', cell: (a) => (a.kind ? a.kind.toLowerCase() : 'File') },
                  { header: 'Size', cell: (a) => <Size a={a} /> },
                  { header: 'Upload checks', cell: (a) => <UploadBadge state={a.uploadState} /> },
                  { header: 'Removal', cell: (a) => <DeletionBadge state={a.deletion} /> },
                  { header: 'Created', cell: (a) => <span className="whitespace-nowrap">{formatTimestamp(a.createdAt)}</span> },
                ]}
              />
              <Pager pagination={list.data.pagination} hrefFor={(page) => nav.href({ page })} />
            </div>
          )}
        </div>
      ) : (
        <QueryView query={list} loadingLabel="Loading stored-file records">
          {() => null}
        </QueryView>
      )}
    </>
  );
}

/** Applied on submit; ids are checked before they reach the URL. */
function StorageFilterForm({ filters, onApply }: { filters: StorageUrlFilters; onApply: (f: Partial<StorageUrlFilters>) => void }) {
  const [f, setF] = useState(filters);
  const [errors, setErrors] = useState<Partial<Record<keyof StorageUrlFilters, string>>>({});
  const field = (k: 'reference' | 'accountId' | 'from' | 'to') => ({
    value: f[k] ?? '',
    error: errors[k],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value || undefined }),
  });
  const select = (k: 'source' | 'uploadState' | 'deletion' | 'kind') => ({
    value: f[k] ?? '',
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value || undefined }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = { ...f, reference: f.reference?.trim() || undefined, accountId: f.accountId?.trim() || undefined };
    const next: typeof errors = {};
    if (t.reference && !UUID.test(t.reference)) next.reference = 'Enter a full record reference.';
    if (t.accountId && !UUID.test(t.accountId)) next.accountId = 'Enter a full account ID.';
    if (t.from && t.to && t.from > t.to) next.to = 'Must be on or after the start date.';
    setErrors(next);
    if (Object.keys(next).length === 0) onApply(t);
  };
  const hasFilters = Object.entries(filters).some(([k, v]) => k !== 'page' && v);
  return (
    <form onSubmit={submit} noValidate aria-label="Filter stored-file records" className="mb-8 grid gap-4 rounded-xl border border-border bg-surface p-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          id="source"
          label="Area"
          {...select('source')}
          options={[{ value: '', label: 'All areas' }, ...STORAGE_ASSET_SOURCES.map((s) => ({ value: s, label: STORAGE_SOURCE_LABEL[s] }))]}
        />
        <SelectField
          id="uploadState"
          label="Upload checks"
          {...select('uploadState')}
          options={[{ value: '', label: 'Any state' }, ...UPLOAD_STATES.map((s) => ({ value: s, label: UPLOAD_STATE[s].label }))]}
        />
        <SelectField
          id="deletion"
          label="Removal"
          {...select('deletion')}
          options={[{ value: '', label: 'Any' }, ...DELETION_STATES.map((s) => ({ value: s, label: DELETION_STATE[s].label }))]}
        />
        <SelectField
          id="kind"
          label="Type"
          {...select('kind')}
          options={[{ value: '', label: 'Any type' }, ...ASSET_KINDS.map((k) => ({ value: k, label: k.toLowerCase() }))]}
        />
        <TextField id="reference" label="Record reference" spellCheck={false} className="font-mono" {...field('reference')} />
        <TextField id="accountId" label="Account ID" spellCheck={false} className="font-mono" {...field('accountId')} />
        <TextField id="from" label="Created from" type="date" {...field('from')} />
        <TextField id="to" label="Created to" type="date" {...field('to')} />
      </div>
      <p className="text-sm text-foreground-muted">Dates are when the upload was started. Up to 366 days at a time.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit">Apply filters</Button>
        {hasFilters && (
          <Button asChild variant="ghost">
            <Link href={BASE}>Clear filters</Link>
          </Button>
        )}
      </div>
    </form>
  );
}

// ─── Detail ─────────────────────────────────────────────────────────────────

const NOT_FOUND = { title: 'We couldn’t find this record', backHref: BASE, backLabel: 'Back to storage & scans' };

export function StorageDetail({ reference }: { reference: string }) {
  const query = useStorageAsset(reference);
  return (
    <QueryView query={query} notFound={NOT_FOUND} loadingLabel="Loading stored-file record">
      {(a) => (
        <>
          <PageHeader
            back={{ href: BASE, label: 'Storage & scans' }}
            eyebrow="Stored-file record"
            title={`${STORAGE_SOURCE_LABEL[a.source]} · ${a.kind ? a.kind.toLowerCase() : 'file'}`}
            description={`Created ${formatDateTime(a.createdAt)}`}
          />
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Record">
              <Facts
                items={[
                  ['Reference', <span key="r" className="font-mono text-sm break-all">{a.reference}</span>],
                  ['Area', STORAGE_SOURCE_LABEL[a.source]],
                  [
                    'Account',
                    a.accountId ? (
                      <Link key="a" href={`/admin/users/${a.accountId}`} className={`font-mono text-sm break-all ${linkClass}`}>
                        {a.accountId}
                      </Link>
                    ) : a.source === 'DEATH_EVIDENCE' ? (
                      'Not shown for evidence'
                    ) : null,
                  ],
                  [
                    'Size',
                    `${formatBytes(a.sizeBytes)} (${a.sizeBytes.toLocaleString('en-AU')} bytes, ${a.sizeVerified ? 'verified against storage' : 'declared, not verified'})`,
                  ],
                  ['Upload checks', <UploadBadge key="u" state={a.uploadState} />],
                  ['Verified', a.verifiedAt ? formatDateTime(a.verifiedAt) : NOT_RECORDED],
                  ['Malware scan result', 'Not recorded per file'],
                  ['Removal', <DeletionBadge key="d" state={a.deletion} />],
                  ['Deleted', a.deletedAt ? formatDateTime(a.deletedAt) : a.uploadState === 'failed' ? 'Not deleted (failed records are removed by cleanup)' : '—'],
                  ['Removal recorded', a.storageDeletedAt ? formatDateTime(a.storageDeletedAt) : '—'],
                  ['Storage', a.legacyStorage ? 'Legacy B2 (never removed automatically)' : 'ImageKit'],
                  ['Last updated', formatDateTime(a.updatedAt)],
                ]}
              />
            </Panel>
            <div className="grid content-start gap-6">
              <Panel title="What these states mean">
                <ul className="grid list-disc gap-1.5 pl-5 text-sm text-foreground-secondary">
                  <li>{UPLOAD_STATE[a.uploadState].description}</li>
                  <li>{DELETION_STATE[a.deletion].description}</li>
                  <li>No attempt history is stored; only the times above are recorded.</li>
                  <li>The file, its name, location and any link stay private; this page cannot open them.</li>
                </ul>
              </Panel>
              {a.accountId && (
                <nav aria-label="Related records" className="grid gap-2 text-sm">
                  <Link href={`${BASE}?accountId=${a.accountId}`} className={`w-fit ${linkClass}`}>
                    All stored-file records for this account
                  </Link>
                </nav>
              )}
            </div>
          </div>
        </>
      )}
    </QueryView>
  );
}
