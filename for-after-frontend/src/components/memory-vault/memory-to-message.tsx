'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import type { UseMutationResult } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { CONTENT_TYPE_INFO } from '@/components/messages/message-bits';
import { RecipientChecklist, Section } from '@/components/messages/message-form';
import { ChoiceGroup, FormError, TextField } from '@/components/shared/form-field';
import { PageHeader } from '@/components/shared/page-header';
import { QueryView, Spinner } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { useMediaList } from '@/hooks/use-media';
import { memories, useAnswerMessage, usePrompt } from '@/hooks/use-vault';
import type { ApiError } from '@/lib/api/errors';
import type { MediaScope } from '@/lib/api/media';
import type { MemoryMessageInput } from '@/lib/api/memory-vault';
import { CONTENT_TYPES, type Message } from '@/lib/api/messages';
import type { PromptArea } from '@/lib/api/prompts';
import { humanize } from '@/lib/format';
import { memoryMessageSchema, type MemoryMessageValues } from '@/schemas/vault';

const heading = (
  <>
    Create a <em>message</em>
  </>
);

/**
 * Phase 13B: "share" a memory by making a new, separate DRAFT message from the
 * parts the Customer picks. The memory stays private and unchanged; the
 * message then opens in the normal message page to review, add media and
 * schedule.
 */
export function CreateMessageFromMemory({ id }: { id: string }) {
  const item = memories.useItem(id);
  const create = memories.useCreateMessage(id);
  return (
    <QueryView
      query={item}
      notFound={{ title: 'We couldn’t find this memory', backHref: '/memory-vault', backLabel: 'Back to Memory Vault' }}
    >
      {(m) => (
        <>
          <PageHeader
            back={{ href: `/memory-vault/${id}`, label: m.title }}
            title={heading}
            description="Your memory stays private. A separate message will be created from the content you choose."
          />
          <CreateMessageForm
            source="memory"
            title={m.title}
            hasText={Boolean(m.textContent?.trim())}
            mediaScope={{ kind: 'memory-vault', id }}
            create={create}
          />
        </>
      )}
    </QueryView>
  );
}

const PROMPT_SOURCES = {
  'my-story': {
    source: 'story',
    label: 'My Story',
    description: 'Your story stays private. A separate message will be created from the content you choose.',
  },
  'my-wishes': {
    source: 'wish',
    label: 'My Wishes',
    description: 'Your wish stays private. This creates a separate message for the people you choose.',
  },
} as const;

/**
 * The same for a My Story answer (Phase 14B) or a wish (Phase 15B), both
 * approved policies. The answer stays private; a story's linked memories are
 * never copied. After-death sharing is the message's own schedule.
 */
export function CreateMessageFromPrompt({ area, promptKey }: { area: PromptArea; promptKey: string }) {
  const prompt = usePrompt(area, promptKey);
  const create = useAnswerMessage(area, promptKey);
  const { source, label, description } = PROMPT_SOURCES[area];
  return (
    <QueryView
      query={prompt}
      notFound={{ title: 'We couldn’t find this prompt', backHref: `/${area}`, backLabel: `Back to ${label}` }}
    >
      {(p) => (
        <>
          <PageHeader
            back={{ href: `/${area}/${encodeURIComponent(promptKey)}`, label: p.prompt }}
            title={heading}
            description={description}
          />
          <CreateMessageForm
            source={source}
            title={p.prompt}
            hasText={Boolean(p.response?.textContent?.trim())}
            mediaScope={{ kind: area, id: promptKey }}
            create={create}
          />
        </>
      )}
    </QueryView>
  );
}

const COPY_NOTE = {
  memory:
    'Copies are made for the message. Editing or deleting the memory later won’t change it, and its category and tags are not shared.',
  story:
    'Copies are made for the message. Editing or deleting your story later won’t change it, and memories linked to your story are not shared.',
  wish: 'Copies are made for the message. Editing or deleting your wish later won’t change or cancel it. To share it after your passing, choose “After death” timing on the message.',
};

/** Pick people (the normal checklist), the type and what to copy; then open the new draft. */
function CreateMessageForm({
  source,
  title,
  hasText,
  mediaScope,
  create,
}: {
  source: 'memory' | 'story' | 'wish';
  title: string;
  hasText: boolean;
  mediaScope: MediaScope;
  create: UseMutationResult<Message, ApiError, MemoryMessageInput>;
}) {
  const router = useRouter();
  const media = useMediaList(mediaScope);
  const ready = media.data?.filter((a) => a.status === 'READY') ?? [];
  // Synchronous guard: two quick clicks can both pass validation before React re-renders.
  const locked = useRef(false);
  const form = useForm<MemoryMessageValues>({
    resolver: zodResolver(memoryMessageSchema),
    defaultValues: { title, contentType: 'MIXED', includeText: hasText, mediaAssetIds: [], recipientIds: [] },
  });
  const { errors } = form.formState;
  const [recipientIds, mediaAssetIds] = useWatch({ control: form.control, name: ['recipientIds', 'mediaAssetIds'] });
  const toggle = (field: 'recipientIds' | 'mediaAssetIds', current: string[], value: string) =>
    form.setValue(field, current.includes(value) ? current.filter((x) => x !== value) : [...current, value], {
      shouldDirty: true,
      shouldValidate: form.formState.isSubmitted,
    });
  const pending = create.isPending || create.isSuccess;

  return (
    <form
      noValidate
      onSubmit={(event) =>
        form.handleSubmit((v) => {
          if (locked.current) return;
          locked.current = true;
          create.mutate(
            { ...v, title: v.title.trim(), includeText: hasText && v.includeText },
            {
              onSuccess: (message) => {
                toast.success('Draft message created');
                router.push(`/messages/${message.id}`);
              },
              onError: () => {
                locked.current = false;
              },
            },
          );
        })(event)
      }
      className="grid max-w-3xl gap-10"
    >
      <FormError error={create.error} />
      <fieldset disabled={pending} className="grid gap-10">
        <Section title="Who is it for?">
          <RecipientChecklist
            selected={recipientIds}
            onToggle={(rid) => toggle('recipientIds', recipientIds, rid)}
            error={errors.recipientIds?.message}
          />
        </Section>

        <Section title="What kind of message?">
          <ChoiceGroup
            legend="Message type"
            className="sm:grid-cols-2"
            registration={form.register('contentType')}
            choices={CONTENT_TYPES.map((t) => {
              const info = CONTENT_TYPE_INFO[t];
              return {
                value: t,
                label: info.label,
                description: info.description,
                icon: <info.icon aria-hidden strokeWidth={1.5} className="size-4 text-primary" />,
              };
            })}
          />
        </Section>

        <Section title={`What to copy from the ${source}`}>
          <TextField id="title" label="Message title" error={errors.title?.message} {...form.register('title')} />
          <div role="group" aria-label={`${source[0].toUpperCase()}${source.slice(1)} content`} className="grid gap-3">
            <label className="flex items-center gap-3">
              <input type="checkbox" className="size-4 accent-primary" disabled={!hasText} {...form.register('includeText')} />
              {hasText ? `The ${source}’s written text` : `This ${source} has no written text`}
            </label>
            {ready.map((a) => (
              <label key={a.id} className="flex items-center gap-3">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={mediaAssetIds.includes(a.id)}
                  onChange={() => toggle('mediaAssetIds', mediaAssetIds, a.id)}
                />
                <span>
                  {humanize(a.kind)}: <span className="break-all">{a.originalFileName}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="flex items-start gap-2 text-sm text-foreground-muted">
            <Lock aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0" />
            {COPY_NOTE[source]}
          </p>
        </Section>
      </fieldset>
      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={pending} aria-busy={pending || undefined}>
          {pending && <Spinner />}
          {pending ? 'Creating…' : 'Create draft message'}
        </Button>
      </div>
    </form>
  );
}
