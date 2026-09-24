"use client";

import { useActionState } from "react";
import { saveCustomerAction, type FormState } from "../actions";
import { Alert, Button, Field, Textarea } from "@/components/ui";

const initial: FormState = {};

export function CustomerForm() {
  const [state, action, pending] = useActionState(saveCustomerAction, initial);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Code" name="code" required hint="Your own reference, e.g. CUST-014." />
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
        <Field
          label="Company registration no."
          name="registrationNo"
          hint="SSM number, where the customer is a company."
        />
        <Field
          label="Tax identification no."
          name="taxIdentifier"
          hint="Needed later for e-Invoice submission."
        />
        <Field
          label="Credit limit (RM)"
          name="creditLimit"
          hint="Optional. Blank means no limit is recorded."
        />
      </div>

      <Textarea label="Address" name="address" rows={2} />
      <Textarea label="Notes" name="notes" rows={2} />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Add customer"}
      </Button>
    </form>
  );
}
