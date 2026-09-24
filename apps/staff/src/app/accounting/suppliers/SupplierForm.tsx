"use client";

import { useActionState } from "react";
import { saveSupplierAction, type FormState } from "../actions";
import { Alert, Button, Field, Textarea } from "@/components/ui";

const initial: FormState = {};

export function SupplierForm() {
  const [state, action, pending] = useActionState(saveSupplierAction, initial);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Code" name="code" required hint="Your own reference, e.g. SUPP-007." />
        <Field label="Name" name="name" required />
        <Field label="Contact person" name="contactPerson" />
        <Field label="Email" name="email" type="email" />
        <Field label="Phone" name="phone" />
        <Field
          label="Payment terms (days)"
          name="paymentTermsDays"
          type="number"
          defaultValue="30"
          inputMode="numeric"
        />
        <Field label="Company registration no." name="registrationNo" />
        <Field label="Tax identification no." name="taxIdentifier" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bank" name="bankName" />
        <Field
          label="Bank account number"
          name="bankAccountNo"
          hint="Shown masked in listings. Any change to it is flagged in the audit trail."
        />
      </div>

      <Textarea label="Address" name="address" rows={2} />
      <Textarea label="Notes" name="notes" rows={2} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Add supplier"}
      </Button>
    </form>
  );
}
