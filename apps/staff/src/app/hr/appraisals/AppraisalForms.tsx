"use client";

import { useActionState, useState } from "react";
import {
  acknowledgeAction,
  openCycleAction,
  reviewAction,
  saveCycleAction,
  selfAssessAction,
} from "../workflow-actions";
import type { FormState } from "../../accounting/action-errors";
import { Alert, Button, Field } from "@/components/ui";

const initial: FormState = {};

export interface Template {
  scale?: { min: number; max: number } | null;
  sections: Array<{
    key: string;
    title: string;
    questions: Array<{ key: string; prompt: string; rated?: boolean; comment?: boolean }>;
  }>;
}

/**
 * Creating a cycle.
 *
 * The form is written one section per line — "Delivery: report quality, meeting
 * dates" — because a template editor is a lot of machinery for a firm of this size,
 * and the JSON field is there for anything the shorthand cannot express. What CAC
 * asks about its staff is CAC's business; the shape is all that is checked.
 */
export function CycleForm({ defaultFrom, defaultTo }: { defaultFrom: string; defaultTo: string }) {
  const [state, action, pending] = useActionState(saveCycleAction, initial);
  const [advanced, setAdvanced] = useState(false);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" name="code" required />
        <Field label="Name" name="name" required />
        <Field label="Period from" name="periodFrom" type="date" required defaultValue={defaultFrom} />
        <Field label="Period to" name="periodTo" type="date" required defaultValue={defaultTo} />
        <Field label="Opens on" name="opensOn" type="date" />
        <Field label="Due by" name="dueOn" type="date" />
      </div>

      {advanced ? (
        <div>
          <label htmlFor="templateJson" className="block text-[12px] font-medium">
            The form, as JSON
          </label>
          <textarea
            id="templateJson"
            name="templateJson"
            rows={8}
            placeholder={`{"scale":{"min":1,"max":5},"sections":[{"key":"delivery","title":"Delivery","questions":[{"key":"quality","prompt":"Report quality","rated":true,"comment":true}]}]}`}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 font-mono text-[11px]"
          />
          <button
            type="button"
            onClick={() => setAdvanced(false)}
            className="mt-1 text-[11px] text-[var(--color-link)] hover:underline"
          >
            Use the simple form instead
          </button>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="sections" className="block text-[12px] font-medium">
              What is being assessed
            </label>
            <textarea
              id="sections"
              name="sections"
              rows={5}
              placeholder={"Delivery: report quality, meeting agreed dates\nConduct: dealing with clients, working with colleagues"}
              className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
            />
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">
              One section per line: a heading, a colon, then the things to be rated, separated by
              commas.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Lowest rating" name="scaleMin" inputMode="numeric" defaultValue="1" />
            <Field label="Highest rating" name="scaleMax" inputMode="numeric" defaultValue="5" />
          </div>

          <button
            type="button"
            onClick={() => setAdvanced(true)}
            className="text-[11px] text-[var(--color-link)] hover:underline"
          >
            Paste a form as JSON instead
          </button>
        </>
      )}

      <Field label="Notes" name="notes" />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Create the cycle"}
      </Button>
      <p className="text-[11px] text-[var(--color-muted)]">
        Creating it does not start it. Opening the cycle is a separate act, and it creates one
        appraisal per person whose manager is recorded.
      </p>
    </form>
  );
}

export function OpenCycle({ cycleId, name }: { cycleId: string; name: string }) {
  const [state, action, pending] = useActionState(openCycleAction, initial);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="cycleId" value={cycleId} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}
      <button
        type="submit"
        disabled={pending}
        className="btn btn-primary px-2 py-1 text-[11px]"
      >
        {pending ? "Opening…" : `Open ${name}`}
      </button>
    </form>
  );
}

/**
 * Filling in a form — either the self-assessment or the review.
 *
 * The same component for both, because the questions are the same and the difference
 * is who is answering and what happens next. Answers are named
 * `answer.<section>.<question>` so the shape survives without the form knowing what
 * is in the template.
 */
export function AnswerForm({
  appraisalId,
  template,
  mode,
  existing,
  showSelfAssessment,
}: {
  appraisalId: string;
  template: Template;
  mode: "self" | "review";
  existing?: Record<string, Record<string, unknown>> | null;
  /** The person's own answers, shown to the reviewer beside their own. */
  showSelfAssessment?: Record<string, Record<string, unknown>> | null;
}) {
  const [state, action, pending] = useActionState(
    mode === "self" ? selfAssessAction : reviewAction,
    initial,
  );

  const valueOf = (
    source: Record<string, Record<string, unknown>> | null | undefined,
    section: string,
    question: string,
  ): string => {
    const value = source?.[section]?.[question];
    return value === undefined || value === null ? "" : String(value);
  };

  return (
    <form action={action} className="space-y-4">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <input type="hidden" name="appraisalId" value={appraisalId} />

      {template.sections.map((section) => (
        <fieldset key={section.key} className="rounded-md border border-[var(--color-line)] p-3">
          <legend className="px-1 text-[12px] font-medium">{section.title}</legend>
          <div className="space-y-3">
            {section.questions.map((question) => (
              <div key={question.key}>
                <label
                  htmlFor={`answer.${section.key}.${question.key}`}
                  className="block text-[12px]"
                >
                  {question.prompt}
                </label>

                {showSelfAssessment && (
                  <p className="text-[11px] text-[var(--color-muted)]">
                    they said:{" "}
                    {valueOf(showSelfAssessment, section.key, question.key) || "nothing"}
                  </p>
                )}

                {question.rated && template.scale ? (
                  <select
                    id={`answer.${section.key}.${question.key}`}
                    name={`answer.${section.key}.${question.key}`}
                    defaultValue={valueOf(existing, section.key, question.key)}
                    className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
                  >
                    <option value="">Not answered</option>
                    {Array.from(
                      { length: template.scale.max - template.scale.min + 1 },
                      (_, index) => template.scale!.min + index,
                    ).map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`answer.${section.key}.${question.key}`}
                    name={`answer.${section.key}.${question.key}`}
                    defaultValue={valueOf(existing, section.key, question.key)}
                    className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px]"
                  />
                )}

                {question.comment && (
                  <input
                    name={`answer.${section.key}.${question.key}_comment`}
                    placeholder="Comment"
                    defaultValue={valueOf(existing, section.key, `${question.key}_comment`)}
                    className="mt-1 w-full rounded-md border border-[var(--color-line)] bg-[var(--color-ink)]/55 px-3 py-1.5 text-[12px]"
                  />
                )}
              </div>
            ))}
          </div>
        </fieldset>
      ))}

      {mode === "review" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Overall"
            name="overallScore"
            inputMode="decimal"
            hint={
              template.scale
                ? `Between ${template.scale.min} and ${template.scale.max}.`
                : undefined
            }
          />
          <div className="sm:col-span-2">
            <Field label="Overall comment" name="overallComment" />
          </div>
        </div>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending
          ? "Saving…"
          : mode === "self"
            ? "Send to my reviewer"
            : "Record the review"}
      </Button>
      {mode === "review" && (
        <p className="text-[11px] text-[var(--color-muted)]">
          The person then reads it and acknowledges it. After that it is fixed — including for you.
        </p>
      )}
    </form>
  );
}

export function AcknowledgeForm({ appraisalId }: { appraisalId: string }) {
  const [state, action, pending] = useActionState(acknowledgeAction, initial);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <input type="hidden" name="appraisalId" value={appraisalId} />

      <div>
        <label htmlFor="comment" className="block text-[12px] font-medium">
          Anything you want on the record
        </label>
        <textarea
          id="comment"
          name="comment"
          rows={3}
          className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[13px]"
        />
        <p className="mt-1 text-[11px] text-[var(--color-muted)]">
          Acknowledging is not agreeing. If you disagree with something, say so here — it becomes
          part of the record, and the review cannot be changed afterwards.
        </p>
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "…" : "I have read this"}
      </Button>
    </form>
  );
}
