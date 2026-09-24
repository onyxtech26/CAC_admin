"use client";

import { useActionState, useState } from "react";
import {
  changeRoleAction,
  changeUserStatusAction,
  createUserAction,
  resetMfaAction,
  resetPasswordAction,
  type AdminFormState,
} from "../actions";
import { Alert, Button, Field } from "@/components/ui";

const initial: AdminFormState = {};

/**
 * The one-time password panel.
 *
 * Deliberately conspicuous and deliberately transient: it is the only time the
 * password is visible, so the screen says so plainly rather than letting an
 * administrator assume they can look it up again later.
 */
function OneTimePassword({ password, email }: { password: string; email?: string }) {
  return (
    <div className="rounded-md border border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] bg-[var(--color-warn-bg)] p-3">
      <p className="text-[12px] font-semibold text-[var(--color-warn)]">
        One-time password{email ? ` for ${email}` : ""}
      </p>
      <p className="numeric mt-2 select-all break-all font-mono text-[16px] font-semibold">
        {password}
      </p>
      <p className="mt-2 text-[11px] text-[var(--color-muted)]">
        Shown once. It is stored only as a hash, so nobody — including an administrator — can read it
        again. Hand it over directly, not by email or chat. The account must change it at first
        sign-in.
      </p>
    </div>
  );
}

export function NewUserForm({
  roles,
  canAssignRoles,
}: {
  roles: Array<{ key: string; description: string }>;
  canAssignRoles: boolean;
}) {
  const [state, action, pending] = useActionState(createUserAction, initial);

  return (
    <form action={action} className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && !state.oneTimePassword && <Alert tone="ok">{state.notice}</Alert>}
      {state.oneTimePassword && (
        <OneTimePassword password={state.oneTimePassword} email={state.oneTimePasswordFor} />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" name="fullName" required />
        <Field label="Email address" name="email" type="email" required />
      </div>

      {canAssignRoles ? (
        <fieldset>
          <legend className="mb-1 text-[12px] font-medium">Roles</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {roles.map((role) => (
              <label key={role.key} className="flex items-start gap-2 text-[12px]">
                <input type="checkbox" name="roles" value={role.key} className="mt-0.5" />
                <span>
                  <span className="font-medium">{role.key.replace(/_/g, " ")}</span>
                  <span className="block text-[11px] text-[var(--color-muted)]">
                    {role.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="text-[12px] text-[var(--color-muted)]">
          You can create the account but not grant roles. Someone with role administration has to do
          that separately.
        </p>
      )}

      <label className="flex items-center gap-2 text-[12px]">
        <input type="checkbox" name="mfaEnforced" defaultChecked value="on" />
        Require an authenticator app
      </label>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating…" : "Create account"}
      </Button>
    </form>
  );
}

export function UserRowActions({
  userId,
  email,
  status,
  isSelf,
  hasMfa,
  canManageRoles,
}: {
  userId: string;
  email: string;
  status: string;
  isSelf: boolean;
  hasMfa: boolean;
  canManageRoles: boolean;
}) {
  const [statusState, statusAction, statusPending] = useActionState(changeUserStatusAction, initial);
  const [passwordState, passwordAction, passwordPending] = useActionState(
    resetPasswordAction,
    initial,
  );
  const [mfaState, mfaAction, mfaPending] = useActionState(resetMfaAction, initial);

  const error = statusState.error ?? passwordState.error ?? mfaState.error;

  return (
    <div className="space-y-1.5">
      {error && <p className="text-[11px] text-[var(--color-danger)]">{error}</p>}
      {passwordState.oneTimePassword && (
        <OneTimePassword password={passwordState.oneTimePassword} email={email} />
      )}
      {mfaState.notice && <p className="text-[11px] text-[var(--color-ok)]">{mfaState.notice}</p>}

      <div className="flex flex-wrap gap-1.5">
        {!isSelf && (
          <form action={statusAction}>
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="status" value={status === "active" ? "suspended" : "active"} />
            <SmallButton pending={statusPending}>
              {status === "active" ? "Suspend" : "Reactivate"}
            </SmallButton>
          </form>
        )}

        <form action={passwordAction}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="email" value={email} />
          <SmallButton pending={passwordPending}>Reset password</SmallButton>
        </form>

        {hasMfa && (
          <ReasonedForm
            action={mfaAction}
            userId={userId}
            label="Remove authenticator"
            prompt={`Removing ${email}'s authenticator lets them enrol a new device. Why?`}
            pending={mfaPending}
          />
        )}

        {canManageRoles && (
          <a
            href={`/admin/users/${userId}`}
            className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)]"
          >
            Roles
          </a>
        )}
      </div>
    </div>
  );
}

function SmallButton({ children, pending }: { children: React.ReactNode; pending: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)] disabled:opacity-50"
    >
      {pending ? "Working…" : children}
    </button>
  );
}

/**
 * A button that will not submit without a reason.
 *
 * The server refuses a blank reason too; asking here means the administrator is
 * prompted before the round trip rather than after it.
 */
function ReasonedForm({
  action,
  userId,
  label,
  prompt,
  pending,
}: {
  action: (formData: FormData) => void;
  userId: string;
  label: string;
  prompt: string;
  pending: boolean;
}) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        const reason = window.prompt(prompt);
        if (!reason?.trim()) {
          event.preventDefault();
          return;
        }
        const field = event.currentTarget.elements.namedItem("reason");
        if (field instanceof HTMLInputElement) field.value = reason;
      }}
    >
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="reason" value="" />
      <SmallButton pending={pending}>{label}</SmallButton>
    </form>
  );
}

export function RoleToggle({
  userId,
  role,
  held,
  disabled,
  disabledReason,
}: {
  userId: string;
  role: string;
  held: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, action, pending] = useActionState(changeRoleAction, initial);
  const [reason, setReason] = useState("");

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="role" value={role} />
      <input type="hidden" name="grant" value={held ? "false" : "true"} />
      {held && <input type="hidden" name="reason" value={reason} />}

      {held && (
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason (optional)"
          aria-label={`Reason for revoking ${role}`}
          className="w-40 rounded border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[11px]"
        />
      )}

      <button
        type="submit"
        disabled={pending || disabled}
        title={disabled ? disabledReason : undefined}
        className={`rounded border px-2 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
          held
            ? "border-[var(--color-line-strong)] hover:bg-[var(--color-canvas)]"
            : "border-[var(--color-navy)] bg-[var(--color-navy)] text-white"
        }`}
      >
        {pending ? "…" : held ? "Revoke" : "Grant"}
      </button>

      {state.error && <span className="text-[11px] text-[var(--color-danger)]">{state.error}</span>}
    </form>
  );
}
