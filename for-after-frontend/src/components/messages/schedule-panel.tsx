"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, CircleAlert, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch, type UseFormRegisterReturn } from "react-hook-form";
import { toast } from "sonner";
import { describeSchedule } from "@/components/messages/message-bits";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { FormError, TextField } from "@/components/shared/form-field";
import { Spinner } from "@/components/shared/states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useScheduleMutation } from "@/hooks/use-vault";
import type { Message, Schedule, ScheduleInput } from "@/lib/api/messages";
import {
  fullName,
  isoToLocalInputs,
  localToOffsetIso,
  timeZoneLabel,
} from "@/lib/format";
import { scheduleSchema, type ScheduleValues } from "@/schemas/vault";

const TRIGGERS: {
  value: ScheduleValues["triggerType"];
  label: string;
  description: string;
}[] = [
  {
    value: "FIXED_DATE",
    label: "On a date you choose",
    description: "Share on a specific date and time.",
  },
  {
    value: "ON_DEATH",
    label: "After my passing",
    description: "Share after your passing has been formally verified.",
  },
  {
    value: "AFTER_DEATH",
    label: "Some time after my passing",
    description: "Share a set number of days after the verified date of death.",
  },
];

// Death report ≠ verification ≠ release: only For After's verification makes these eligible.
const VERIFICATION_NOTE =
  "A report from a trusted contact is never enough on its own.";

const audience = (recipients: Message["recipients"]) =>
  recipients.length === 1 ? fullName(recipients[0]) : "your recipients";

export function SchedulePanel({
  message,
  schedule,
  scheduleLoading,
  issues,
}: {
  message: Message;
  schedule: Schedule | null;
  scheduleLoading: boolean;
  /** Client-side composition guidance for drafts (empty = ready). */
  issues: string[];
}) {
  const [changing, setChanging] = useState(false);
  const mutation = useScheduleMutation(message.id);
  const choosing =
    message.status === "DRAFT" || (message.status === "SCHEDULED" && changing);
  const ref = useFocusOnArrival();

  return (
    <section
      ref={ref}
      id={SCHEDULE_SECTION_ID}
      tabIndex={-1}
      aria-labelledby="schedule-heading"
      // scroll-mt clears the sticky 80px header; the brief border tint marks where they landed.
      className="grid min-w-0 scroll-mt-28 gap-5 rounded-xl border border-border bg-surface p-6 outline-none transition-colors duration-700 data-[arrived]:border-primary sm:p-8 xl:p-7"
    >
      <div className="grid gap-1.5">
        <h2 id="schedule-heading" className="text-2xl">
          When will it be shared?
        </h2>
        {choosing && (
          <p className="text-sm leading-relaxed text-foreground-muted">
            Choose when this message becomes available to{" "}
            {audience(message.recipients)}.
          </p>
        )}
      </div>

      {message.status === "DRAFT" && (
        <>
          <Readiness issues={issues} />
          <ScheduleForm
            mode="create"
            pending={mutation.isPending}
            error={mutation.error}
            onSubmit={(input) =>
              mutation.mutate(
                { type: "create", input },
                { onSuccess: () => toast.success("Message scheduled") },
              )
            }
          />
        </>
      )}

      {message.status !== "DRAFT" && scheduleLoading && (
        <Skeleton className="h-16 rounded-md" />
      )}

      {message.status === "SCHEDULED" && schedule && (
        <>
          <p className="text-lg">{describeSchedule(schedule)}</p>
          {changing ? (
            <ScheduleForm
              mode="update"
              initial={schedule}
              pending={mutation.isPending}
              error={mutation.error}
              onCancel={() => setChanging(false)}
              onSubmit={(input) =>
                mutation.mutate(
                  { type: "update", input },
                  {
                    onSuccess: () => {
                      setChanging(false);
                      toast.success("Schedule updated");
                    },
                  },
                )
              }
            />
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setChanging(true)}
              >
                Change timing
              </Button>
              <ConfirmDialog
                tone="default"
                trigger={
                  <Button type="button" variant="ghost">
                    <Undo2 aria-hidden strokeWidth={1.5} />
                    Unschedule to edit
                  </Button>
                }
                title="Unschedule this message?"
                description="It goes back to being a draft so you can change it, and won't be shared until you schedule it again. Nothing in the message is deleted."
                confirmLabel="Unschedule"
                pending={mutation.isPending}
                error={mutation.error}
                onConfirm={() =>
                  mutation
                    .mutateAsync({ type: "unschedule" })
                    .then(() =>
                      toast.success("Unscheduled: it’s a draft again"),
                    )
                }
              />
            </div>
          )}
        </>
      )}

      {message.status === "RELEASED" && (
        <p className="text-foreground-secondary">
          This message has been released
          {schedule ? ` (${describeSchedule(schedule).toLowerCase()})` : ""}. It
          is kept exactly as it was shared.
        </p>
      )}
      {message.status === "CANCELLED" && (
        <p className="text-foreground-secondary">This message was cancelled.</p>
      )}
    </section>
  );
}

const SCHEDULE_SECTION_ID = "message-schedule";

/**
 * Arriving from "Continue to schedule" (/messages/{id}?focus=schedule): read
 * the param once, drop it from the URL so refresh/Back don't repeat it, then
 * move focus and scroll to this panel. A query param rather than #hash
 * because the panel only exists after the message has loaded.
 */
function useFocusOnArrival() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    const url = new URL(window.location.href);
    if (!el || url.searchParams.get("focus") !== "schedule") return;
    url.searchParams.delete("focus");
    window.history.replaceState(window.history.state, "", url);
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    el.dataset.arrived = "";
    window.setTimeout(() => delete el.dataset.arrived, 1600);
  }, []);
  return ref;
}

function Readiness({ issues }: { issues: string[] }) {
  if (issues.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-success">
        <Check aria-hidden strokeWidth={2} className="size-4" />
        Ready to schedule.
      </p>
    );
  }
  return (
    <div className="grid gap-2 rounded-md bg-surface-muted px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <CircleAlert
          aria-hidden
          strokeWidth={1.5}
          className="size-4 text-warning"
        />
        Before this can be scheduled:
      </p>
      <ul className="ml-6 list-disc leading-relaxed text-foreground-secondary">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </div>
  );
}

const toValues = (s?: Schedule): ScheduleValues => {
  const local = s?.scheduledFor
    ? isoToLocalInputs(s.scheduledFor)
    : { date: "", time: "09:00" };
  return {
    triggerType: s?.triggerType ?? "FIXED_DATE",
    date: local.date,
    time: local.time,
    afterDeathDays: s?.afterDeathDays?.toString() ?? "30",
  };
};

// Each trigger sends exactly its own field; the other is null, as the API expects.
const toInput = (v: ScheduleValues): ScheduleInput => ({
  triggerType: v.triggerType,
  scheduledFor:
    v.triggerType === "FIXED_DATE" ? localToOffsetIso(v.date, v.time) : null,
  afterDeathDays:
    v.triggerType === "AFTER_DEATH" ? Number(v.afterDeathDays) : null,
});

export function ScheduleForm({
  mode,
  initial,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "update";
  initial?: Schedule;
  pending: boolean;
  error: Parameters<typeof FormError>[0]["error"];
  onSubmit: (input: ScheduleInput) => void;
  onCancel?: () => void;
}) {
  const form = useForm<ScheduleValues>({
    resolver: zodResolver(scheduleSchema),
    defaultValues: toValues(initial),
  });
  const { errors } = form.formState;
  const [trigger, date, time] = useWatch({
    control: form.control,
    name: ["triggerType", "date", "time"],
  });
  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((v) => !pending && onSubmit(toInput(v)))}
      className="grid gap-6"
    >
      <FormError error={error} />
      <fieldset disabled={pending} className="grid min-w-0 gap-6">
        <TriggerOptions registration={form.register("triggerType")} />

        {trigger === "FIXED_DATE" && (
          <div className="grid gap-3">
            {/* Two columns only when the card runs full width (below xl); stacked in the sidebar. */}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
              <TextField
                id="date"
                label="Date"
                type="date"
                error={errors.date?.message}
                {...form.register("date")}
              />
              <TextField
                id="time"
                label="Time"
                type="time"
                error={errors.time?.message}
                {...form.register("time")}
              />
            </div>
            <p className="text-[13px] leading-relaxed text-foreground-muted">
              Your time zone: {timeZoneLabel(chosenMoment(date, time))}
            </p>
          </div>
        )}

        {trigger === "ON_DEATH" && (
          <p className="rounded-md bg-surface-muted px-4 py-3 text-[13px] leading-relaxed text-foreground-secondary">
            This message will become eligible for release after your passing has
            been formally verified through For After’s verification process.{" "}
            {VERIFICATION_NOTE}
          </p>
        )}

        {trigger === "AFTER_DEATH" && (
          <div className="grid gap-3">
            <TextField
              id="afterDeathDays"
              label="How long after?"
              type="number"
              inputMode="numeric"
              min={0}
              hint="The message will become eligible for release this many days after the verified date of death."
              trailing={
                <span className="pr-2.5 text-sm text-foreground-muted">
                  days
                </span>
              }
              className="pr-14"
              error={errors.afterDeathDays?.message}
              {...form.register("afterDeathDays")}
            />
            <p className="text-[13px] leading-relaxed text-foreground-muted">
              {VERIFICATION_NOTE}
            </p>
          </div>
        )}
      </fieldset>
      <div className="grid gap-2">
        <Button type="submit" disabled={pending} className="w-full">
          {pending && <Spinner />}
          {mode === "create" ? "Schedule message" : "Save timing"}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onCancel}
            className="w-full"
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** The local moment being chosen, so the timezone line reflects daylight saving on that date. */
function chosenMoment(date: string, time: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const [y, m, d] = date.split("-").map(Number);
  const [hh = 9, mm = 0] = /^\d{2}:\d{2}$/.test(time)
    ? time.split(":").map(Number)
    : [];
  const at = new Date(y, m - 1, d, hh, mm);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * Full-width radio cards, stacked. Native radios, so arrow keys, labels and
 * form state work as usual; the legend is for screen readers since the
 * panel heading already asks the question.
 */
function TriggerOptions({
  registration,
}: {
  registration: UseFormRegisterReturn;
}) {
  return (
    <fieldset className="grid min-w-0 gap-2.5">
      <legend className="sr-only">When will it be shared?</legend>
      {TRIGGERS.map((choice) => (
        <label
          key={choice.value}
          className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-surface px-4 py-3.5 transition-colors hover:border-border-strong has-[:checked]:border-primary has-[:checked]:bg-primary-soft/60 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
        >
          <input
            type="radio"
            value={choice.value}
            className="mt-0.5 size-4 shrink-0 accent-primary"
            {...registration}
          />
          <span className="grid min-w-0 gap-0.5">
            <span className="text-sm font-medium leading-snug">
              {choice.label}
            </span>
            <span className="text-[13px] leading-relaxed text-foreground-muted">
              {choice.description}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
