"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, CircleAlert, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch, type UseFormRegisterReturn } from "react-hook-form";
import { toast } from "sonner";
import { describeSchedule } from "@/components/messages/message-bits";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { SelectField } from "@/components/shared/list-controls";
import { FormError, TextField } from "@/components/shared/form-field";
import { Spinner } from "@/components/shared/states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { recipients as people, useScheduleMutation } from "@/hooks/use-vault";
import {
  RECURRING_TRIGGERS,
  type Message,
  type Schedule,
  type ScheduleInput,
} from "@/lib/api/messages";
import {
  fullName,
  isoToLocalInputs,
  localToOffsetIso,
  timeZoneLabel,
  timeZoneName,
  timeZones,
} from "@/lib/format";
import { scheduleSchema, type ScheduleValues } from "@/schemas/vault";

const TRIGGERS: {
  value: ScheduleValues["triggerType"];
  label: string;
  description: string;
}[] = [
  {
    value: "NOW",
    label: "Right away",
    description: "Share as soon as you schedule it.",
  },
  {
    value: "FIXED_DATE",
    label: "On a date you choose",
    description: "Share on a specific date and time.",
  },
  {
    value: "BIRTHDAY",
    label: "On their birthday, every year",
    description: "Share on each recipient’s own birthday, every year.",
  },
  {
    value: "ANNIVERSARY",
    label: "Every year on a date",
    description: "Share every year on a date that matters, like an anniversary.",
  },
  {
    value: "CUSTOM_EVENT",
    label: "On a special occasion",
    description: "Share once, on a day you name, like a graduation or a wedding.",
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
  {
    value: "ANNUAL_AFTER_DEATH",
    label: "Every year after my passing",
    description:
      "Share each year on the anniversary of the verified date of death.",
  },
];

const LEAP_DAY_NOTE =
  "If the date is 29 February, it’s shared on 28 February in other years.";
const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat("en-AU", { month: "long" }).format(
    new Date(2028, i, 1),
  ),
);

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
            recipients={message.recipients}
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
          {RECURRING_TRIGGERS.includes(schedule.triggerType) && (
            <RecurringStatus
              shared={schedule.releasedRecipientCount ?? 0}
              total={message.recipients.length}
            />
          )}
          {(schedule.releasedRecipientCount ?? 0) > 0 ? null : changing ? (
            <ScheduleForm
              mode="update"
              initial={schedule}
              recipients={message.recipients}
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

const ZONED: ScheduleValues["triggerType"][] = [
  "BIRTHDAY",
  "ANNIVERSARY",
  "CUSTOM_EVENT",
  "ANNUAL_AFTER_DEATH",
];

const toValues = (s?: Schedule): ScheduleValues => {
  const local =
    s?.triggerType === "FIXED_DATE" && s.scheduledFor
      ? isoToLocalInputs(s.scheduledFor)
      : { date: s?.eventDate?.slice(0, 10) ?? "", time: s?.localTime ?? "09:00" };
  return {
    triggerType: s?.triggerType ?? "FIXED_DATE",
    date: local.date,
    time: local.time,
    afterDeathDays: s?.afterDeathDays?.toString() ?? "30",
    timezone: s?.timezone ?? timeZoneName(),
    annualMonth: s?.annualMonth?.toString() ?? "1",
    annualDay: s?.annualDay?.toString() ?? "1",
    eventLabel: s?.eventLabel ?? "",
  };
};

// Each trigger sends exactly its own fields; scheduledFor/afterDeathDays are
// null when unused, the others are left out, as the API expects.
const toInput = (v: ScheduleValues): ScheduleInput => {
  const input: ScheduleInput = {
    triggerType: v.triggerType,
    scheduledFor:
      v.triggerType === "FIXED_DATE" ? localToOffsetIso(v.date, v.time) : null,
    afterDeathDays:
      v.triggerType === "AFTER_DEATH" ? Number(v.afterDeathDays) : null,
  };
  if (ZONED.includes(v.triggerType)) {
    input.timezone = v.timezone;
    input.localTime = v.time;
  }
  if (v.triggerType === "ANNIVERSARY") {
    input.annualMonth = Number(v.annualMonth);
    input.annualDay = Number(v.annualDay);
  }
  if (v.triggerType === "CUSTOM_EVENT") {
    input.eventDate = v.date;
    input.eventLabel = v.eventLabel.trim();
  }
  return input;
};

export function ScheduleForm({
  mode,
  initial,
  recipients = [],
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "update";
  initial?: Schedule;
  /** The message's recipients (BIRTHDAY needs each one's birthday). */
  recipients?: Message["recipients"];
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

        {trigger === "NOW" && (
          <p className="rounded-md bg-surface-muted px-4 py-3 text-[13px] leading-relaxed text-foreground-secondary">
            Your recipients can open it as soon as it’s scheduled, and
            we’ll let them know by email.
          </p>
        )}

        {trigger === "BIRTHDAY" && (
          <div className="grid gap-3">
            <BirthdayCheck recipients={recipients} />
            <ZonedTime form={form} errors={errors} />
            <p className="text-[13px] leading-relaxed text-foreground-muted">
              Each person receives it on their own birthday, so different
              recipients may receive it on different days. {LEAP_DAY_NOTE}
            </p>
          </div>
        )}

        {trigger === "ANNIVERSARY" && (
          <div className="grid gap-3">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
              <Choice
                id="annualMonth"
                label="Month"
                registration={form.register("annualMonth")}
                options={MONTHS.map((name, i) => [String(i + 1), name])}
              />
              <Choice
                id="annualDay"
                label="Day"
                registration={form.register("annualDay")}
                options={Array.from({ length: 31 }, (_, i) => [
                  String(i + 1),
                  String(i + 1),
                ])}
                error={errors.annualDay?.message}
              />
            </div>
            <ZonedTime form={form} errors={errors} />
            <p className="text-[13px] leading-relaxed text-foreground-muted">
              Shared every year on this date. If it has already passed this
              year, the first one is next year. {LEAP_DAY_NOTE}
            </p>
          </div>
        )}

        {trigger === "CUSTOM_EVENT" && (
          <div className="grid gap-3">
            <TextField
              id="eventLabel"
              label="What’s the occasion?"
              maxLength={100}
              hint="For example: Mia’s graduation."
              error={errors.eventLabel?.message}
              {...form.register("eventLabel")}
            />
            <TextField
              id="date"
              label="Date"
              type="date"
              error={errors.date?.message}
              {...form.register("date")}
            />
            <ZonedTime form={form} errors={errors} />
            <p className="text-[13px] leading-relaxed text-foreground-muted">
              Shared once, on this day. It doesn’t repeat.
            </p>
          </div>
        )}

        {trigger === "ANNUAL_AFTER_DEATH" && (
          <div className="grid gap-3">
            <ZonedTime form={form} errors={errors} />
            <p className="rounded-md bg-surface-muted px-4 py-3 text-[13px] leading-relaxed text-foreground-secondary">
              Nothing is shared until your passing has been formally verified
              through For After’s verification process. The first one is
              shared a year after the verified date of death, then once every
              year. {VERIFICATION_NOTE}
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

/**
 * Repeating schedules: shared with some recipients already? Then the message
 * keeps going every year and its timing is fixed (the API refuses changes).
 */
function RecurringStatus({ shared, total }: { shared: number; total: number }) {
  if (shared === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-foreground-muted">
        Repeats every year. You can change the timing or unschedule it until
        it has been shared with someone.
      </p>
    );
  }
  return (
    <p className="rounded-md bg-surface-muted px-4 py-3 text-[13px] leading-relaxed text-foreground-secondary">
      Shared with {shared} of {total} {total === 1 ? "recipient" : "recipients"}{" "}
      so far, and it will keep being shared every year. Because it has already
      been shared, its timing can no longer change.
    </p>
  );
}

/** Birthdays live in People I Love; never guessed here. */
function BirthdayCheck({ recipients }: { recipients: Message["recipients"] }) {
  const all = people.useList();
  if (!all.data) return null;
  const missing = recipients.filter(
    (r) => !all.data.find((p) => p.id === r.id)?.birthday,
  );
  if (missing.length === 0) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md bg-surface-muted px-4 py-3 text-[13px] leading-relaxed"
    >
      <CircleAlert
        aria-hidden
        strokeWidth={1.5}
        className="mt-0.5 size-4 shrink-0 text-warning"
      />
      <span>
        {missing.map(fullName).join(", ")}{" "}
        {missing.length === 1 ? "doesn’t" : "don’t"} have a birthday saved yet.
        Add it in People I Love, or remove them from this message.
      </span>
    </p>
  );
}

type Form = ReturnType<typeof useForm<ScheduleValues>>;

/** Local time + IANA zone (repeating and occasion schedules). */
function ZonedTime({
  form,
  errors,
}: {
  form: Form;
  errors: Form["formState"]["errors"];
}) {
  // The browser's list may use another name for the same zone (Asia/Calcutta
  // for Asia/Kolkata): keep the current value selectable.
  const current = useWatch({ control: form.control, name: "timezone" });
  const listed = timeZones();
  const zones = listed.includes(current) ? listed : [current, ...listed];
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
      <TextField
        id="time"
        label="Time"
        type="time"
        error={errors.time?.message}
        {...form.register("time")}
      />
      <Choice
        id="timezone"
        label="Time zone"
        registration={form.register("timezone")}
        options={zones.map((z) => [z, z.replaceAll("_", " ")])}
        error={errors.timezone?.message}
      />
    </div>
  );
}

/** The shared select plus a field error (the select has no error slot). */
function Choice({
  id,
  label,
  registration,
  options,
  error,
}: {
  id: string;
  label: string;
  registration: UseFormRegisterReturn;
  options: string[][];
  error?: string;
}) {
  return (
    <div className="grid min-w-0 gap-2">
      <SelectField
        id={id}
        label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        options={options.map(([value, text]) => ({ value, label: text }))}
        {...registration}
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
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
