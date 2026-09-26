"use client";

import { useActionState } from "react";
import {
  beginEnrolmentAction,
  changePasswordAction,
  confirmEnrolmentAction,
  revokeSessionAction,
  type AccountFormState,
} from "./actions";
import { Alert, Button, Field } from "@/components/ui";

const initial: AccountFormState = {};

export function PasswordForm({ minLength, mustChange }: { minLength: number; mustChange: boolean }) {
  const [state, action, pending] = useActionState(changePasswordAction, initial);

  return (
    <form action={action} className="space-y-3">
      {mustChange && !state.notice && (
        <Alert tone="warn">
          This account is using a password an administrator generated. Change it now — while it stands,
          somebody other than you has seen it.
        </Alert>
      )}
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.notice && <Alert tone="ok">{state.notice}</Alert>}

      <Field
        label="Current password"
        name="currentPassword"
        type="password"
        required
        autoComplete="current-password"
        hint="Asked for even though you are signed in: it proves the person changing it is you."
      />
      <Field
        label="New password"
        name="newPassword"
        type="password"
        required
        autoComplete="new-password"
        hint={`At least ${minLength} characters. Length matters far more than symbols — a passphrase of ordinary words is both stronger and easier to type.`}
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        required
        autoComplete="new-password"
      />

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}

/**
 * Authenticator enrolment, in two steps.
 *
 * Step one shows a QR code and the secret. Step two asks for a code from the
 * device, which is what actually confirms it: a QR code that was displayed proves
 * nothing, a working code proves the secret arrived.
 */
export function MfaEnrolment() {
  const [begin, beginAction, beginPending] = useActionState(beginEnrolmentAction, initial);
  const [confirm, confirmAction, confirmPending] = useActionState(confirmEnrolmentAction, initial);

  const challenge = confirm.enrolment ?? begin.enrolment;

  if (confirm.recoveryCodes) {
    return (
      <div className="space-y-3">
        <Alert tone="ok">{confirm.notice}</Alert>
        <div className="rounded-md border border-[color-mix(in_srgb,var(--color-warn)_35%,transparent)] bg-[var(--color-warn-bg)] p-3">
          <p className="text-[12px] font-semibold text-[var(--color-warn)]">
            Recovery codes — shown once
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-5">
            {confirm.recoveryCodes.map((code) => (
              <li key={code} className="select-all font-mono text-[13px]">
                {code}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-[var(--color-muted)]">
            Print these or write them down and keep them somewhere your phone is not. Each works once,
            in place of a code, if you lose the device. They are stored only as hashes, so they cannot
            be shown again.
          </p>
        </div>
        <p className="text-[11px] text-[var(--color-muted)]">
          The warning at the top of this page is now out of date — your authenticator is enrolled. It
          is still there because refreshing this page would take the codes above with it, and they
          are shown once. It goes when you follow the link below.
        </p>
        {/* A link rather than automatic navigation: the page must not move on
            until the person has actually taken a copy of the codes. */}
        <a href="/account" className="inline-block text-[12px] text-[var(--color-info)] underline">
          I have saved these codes
        </a>
      </div>
    );
  }

  if (!challenge) {
    return (
      <form action={beginAction} className="space-y-3">
        {begin.error && <Alert tone="danger">{begin.error}</Alert>}
        <p className="text-[12px] text-[var(--color-muted)]">
          A password on its own is one stolen note away from being somebody else&rsquo;s. An
          authenticator app adds a code that changes every 30 seconds and never leaves your phone.
        </p>
        <Button type="submit" variant="primary" disabled={beginPending}>
          {beginPending ? "Preparing…" : "Set up an authenticator"}
        </Button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      {challenge.usingDevelopmentKey && (
        <Alert tone="warn">
          This server is using the built-in development encryption key, so the stored secret is not
          protected. Fine on a laptop; set <span className="font-mono text-[11px]">APP_SECRET_KEY</span>{" "}
          before anyone relies on this in earnest.
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
        <div className="rounded-md border border-[var(--color-line)] bg-white p-2">
          {/* Rendered on the server; the QR library never reaches the browser. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={challenge.qrDataUrl}
            alt="QR code for enrolling an authenticator app"
            width={200}
            height={200}
          />
        </div>
        <div className="space-y-2">
          <p className="text-[12px]">
            Scan this with Google Authenticator, Microsoft Authenticator, 1Password, Aegis or any
            other TOTP app. If you cannot scan, add an account by hand with this key:
          </p>
          <p className="select-all break-all rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 font-mono text-[13px]">
            {challenge.secret.replace(/(.{4})/g, "$1 ").trim()}
          </p>
          <p className="text-[11px] text-[var(--color-muted)]">
            Time-based, 6 digits, 30-second period, SHA-1 — the defaults every app uses.
          </p>
        </div>
      </div>

      <form action={confirmAction} className="space-y-3">
        <input type="hidden" name="deviceId" value={challenge.deviceId} />
        <input type="hidden" name="secret" value={challenge.secret} />
        <input type="hidden" name="uri" value={challenge.uri} />
        <input type="hidden" name="qrDataUrl" value={challenge.qrDataUrl} />
        <input type="hidden" name="usingDevelopmentKey" value={String(challenge.usingDevelopmentKey)} />

        {confirm.error && <Alert tone="danger">{confirm.error}</Alert>}

        <Field
          label="Code from the app"
          name="code"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          hint="Six digits. This is what confirms the device is really yours."
        />

        <Button type="submit" variant="primary" disabled={confirmPending}>
          {confirmPending ? "Checking…" : "Confirm and finish"}
        </Button>
      </form>
    </div>
  );
}

export function SessionRevoke({ sessionId, isCurrent }: { sessionId: string; isCurrent: boolean }) {
  const [state, action, pending] = useActionState(revokeSessionAction, initial);

  if (isCurrent) {
    return <span className="text-[11px] text-[var(--color-faint)]">this device</span>;
  }

  return (
    <form action={action}>
      <input type="hidden" name="sessionId" value={sessionId} />
      {state.error && <p className="text-[11px] text-[var(--color-danger)]">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-[var(--color-line-strong)] px-2 py-1 text-[11px] hover:bg-[var(--color-canvas)] disabled:opacity-50"
      >
        {pending ? "Ending…" : "End session"}
      </button>
    </form>
  );
}
