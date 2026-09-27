"use client";

import { useActionState } from "react";
import { verifyMfa, type FormState } from "../actions";
import { Alert, Button, Field } from "@/components/ui";

const initial: FormState = {};

export default function MfaPage() {
  const [state, action, pending] = useActionState(verifyMfa, initial);

  return (
    <div className="plate rounded-lg p-5">
      <h1 className="text-[15px] font-semibold">Two-step verification</h1>
      <p className="mt-1 text-[12px] text-[var(--color-muted)]">
        Enter the 6-digit code from your authenticator app.
      </p>

      <form action={action} className="mt-5 space-y-4">
        {state.error && <Alert tone="danger">{state.error}</Alert>}

        <Field
          label="Authentication code"
          name="code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          hint="Lost your device? Use one of your recovery codes instead."
        />

        <Button type="submit" disabled={pending}>
          {pending ? "Verifying…" : "Verify"}
        </Button>
      </form>

      <p className="mt-5 border-t border-[var(--color-line)] pt-4 text-[11px] text-[var(--color-muted)]">
        Your password was accepted, but this session is not usable until the second step is
        complete.
      </p>
    </div>
  );
}
