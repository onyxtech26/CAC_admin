"use client";

import { useActionState, useState } from "react";
import {
  createAccountAction,
  toggleAccountAction,
  updateAccountAction,
  type FormState,
} from "../actions";
import { Alert, Button, Field, Select, Textarea } from "@/components/ui";

const initial: FormState = {};

export function NewAccountForm({
  headings,
}: {
  headings: Array<{ code: string; name: string; type: string }>;
}) {
  const [state, action, pending] = useActionState(createAccountAction, initial);
  const [type, setType] = useState("EXPENSE");

  // Only headings of the chosen type can be the parent: a revenue account under
  // an expense heading would break every report that sums by heading. The server
  // enforces it too — this just stops the mistake being offered.
  const eligible = headings.filter((heading) => heading.type === type);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code" name="code" required hint="Digits usually, e.g. 7295." />
        <Field label="Name" name="name" required />
        <div>
          <label htmlFor="f-type" className="block text-[12px] font-medium text-[var(--color-body)]">
            Type
          </label>
          <select
            id="f-type"
            name="type"
            value={type}
            onChange={(event) => setType(event.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-line-strong)] bg-[var(--color-ink)]/55 px-3 py-2 text-[14px] outline-none focus:border-[var(--color-info)]"
          >
            <option value="ASSET">Asset</option>
            <option value="LIABILITY">Liability</option>
            <option value="EQUITY">Equity</option>
            <option value="REVENUE">Revenue</option>
            <option value="EXPENSE">Expense</option>
          </select>
        </div>
        <Select
          label="Sits under"
          name="parentCode"
          placeholder="Nothing — top level"
          options={eligible.map((heading) => ({
            value: heading.code,
            label: `${heading.code} ${heading.name}`,
          }))}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Kind"
          name="isPostable"
          defaultValue="postable"
          options={[
            { value: "postable", label: "Postable — entries go to it" },
            { value: "heading", label: "Heading — groups other accounts" },
          ]}
        />
        <Field label="Subtype" name="subtype" hint="Optional tag used by reports, e.g. bank." />
      </div>

      <label className="flex items-start gap-2 text-[12px]">
        <input type="checkbox" name="isContra" className="mt-0.5" />
        <span>
          <span className="font-medium">Contra account</span>
          <span className="block text-[var(--color-muted)]">
            Carries the opposite side to its type: accumulated depreciation under assets, discounts
            under revenue.
          </span>
        </span>
      </label>

      <Textarea label="Description" name="description" rows={2} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating…" : "Create account"}
      </Button>
    </form>
  );
}

/**
 * Takes an account out of use, or puts it back.
 *
 * Never a delete: an account with postings is part of the record, and one
 * without still appears in the audit trail as something that existed.
 */
export function AccountToggle({
  accountId,
  isActive,
  code,
  name,
}: {
  accountId: string;
  isActive: boolean;
  code: string;
  name: string;
}) {
  const [state, action, pending] = useActionState(toggleAccountAction, initial);

  return (
    <form action={action}>
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="activate" value={isActive ? "false" : "true"} />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        title={
          isActive
            ? `Take ${code} ${name} out of use. Its history stays.`
            : `Put ${code} ${name} back in use.`
        }
        className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)] disabled:opacity-50"
      >
        {isActive ? "Retire" : "Restore"}
      </button>
    </form>
  );
}

/**
 * Editing an account's descriptive fields.
 *
 * `updateAccount` existed in the core and `updateAccountAction` existed in the server actions, and
 * no screen reached either — so the chart could be created and retired and never corrected. It is
 * offered here rather than on the list because the list is long and an edit box on every row is an
 * invitation to change the wrong one.
 *
 * The code, the type and the normal side are not here and are not editable: they are what every
 * posted line means, and changing them would restate history. A wrong one is retired and replaced.
 */
export function EditAccountForm({
  accountId,
  name,
  subtype,
  description,
  einvoiceClassificationCode,
  isRevenue,
}: {
  accountId: string;
  name: string;
  subtype: string | null;
  description: string | null;
  einvoiceClassificationCode: string | null;
  isRevenue: boolean;
}) {
  const [state, action, pending] = useActionState(updateAccountAction, initial);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="accountId" value={accountId} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <Field label="Name" name="name" required defaultValue={name} />
      <Field
        label="Subtype"
        name="subtype"
        defaultValue={subtype ?? ""}
        hint="Optional tag used by reports, e.g. bank."
      />
      <Textarea label="Description" name="description" defaultValue={description ?? ""} />

      {isRevenue && (
        <Field
          label="LHDN classification code"
          name="einvoiceClassificationCode"
          defaultValue={einvoiceClassificationCode ?? ""}
          hint={
            "From LHDN's own taxonomy, for e-Invoicing. Set once per service rather than typed on " +
            "every invoice line. Left blank, a submission naming this account refuses rather than " +
            "guessing — see Q-FIN-2."
          }
        />
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
