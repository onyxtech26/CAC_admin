"use client";

import { useActionState } from "react";
import { signIn, type FormState } from "./actions";
import { Alert, Button, Field } from "@/components/ui";

const initial: FormState = {};

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, initial);

  return (
    <div className="plate rounded-lg p-5">
      <h1 className="page-title text-[19px]">Sign in</h1>
      <p className="mt-1 text-[12px] text-[var(--color-muted)]">
        Staff access only. Sign-in attempts are recorded.
      </p>

      <form action={action} className="mt-5 space-y-4">
        {state.error && <Alert tone="danger">{state.error}</Alert>}

        <Field
          label="Email address"
          name="email"
          type="email"
          required
          autoComplete="username"
        />
        <Field
          label="Password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />

        <Button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="mt-5 border-t border-[var(--color-line)] pt-4 text-[11px] text-[var(--color-muted)]">
        Forgotten your password? Contact an administrator — a reset link will be sent to your
        registered address.
      </p>
    </div>
  );
}
