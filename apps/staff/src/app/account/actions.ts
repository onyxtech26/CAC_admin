"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { getDb } from "@cac/db";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  beginMfaEnrolment,
  changeOwnPassword,
  confirmMfaEnrolment,
  getSetting,
  revokeSession,
} from "@cac/core";
import { getRequestContext, requirePrincipal } from "@/lib/auth";

/**
 * Self-service actions.
 *
 * These act on the caller's own account only, so the session is the
 * authorisation — there is no capability to check. Every one of them takes the
 * user id from the resolved session and never from the form, which is what stops
 * a crafted request acting on somebody else.
 */

export interface AccountFormState {
  error?: string;
  field?: string;
  notice?: string;
  /** Enrolment challenge, held across the two steps. */
  enrolment?: {
    deviceId: string;
    secret: string;
    uri: string;
    /** The QR rendered server-side, so the QR library never reaches the browser. */
    qrDataUrl: string;
    usingDevelopmentKey: boolean;
  };
  /** Recovery codes, shown once on successful enrolment. */
  recoveryCodes?: string[];
}

function toState(error: unknown, fallback: string): AccountFormState {
  if (error instanceof ValidationError) return { error: error.message, field: error.field };
  if (error instanceof ConflictError || error instanceof NotFoundError) {
    return { error: error.message };
  }
  console.error("[account] unexpected error:", error);
  return { error: fallback };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

/**
 * Renders the otpauth URI as a QR code, on the server.
 *
 * Kept here rather than in a client component so the QR library stays out of the
 * browser bundle, and so the secret is never handed to client-side JavaScript in a
 * form it would have to encode itself.
 *
 * Error correction level M and a generous quiet zone: this gets photographed off a
 * screen, sometimes a dim one.
 */
async function renderQr(uri: string): Promise<string> {
  const QRCode = await import("qrcode");
  return QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 2, width: 200 });
}

export async function changePasswordAction(
  _prev: AccountFormState,
  form: FormData,
): Promise<AccountFormState> {
  try {
    const principal = await requirePrincipal();
    const db = await getDb();
    const context = await getRequestContext();
    const minLength = await getSetting<number>(db, "security.password_min_length", 12);

    await db.transaction(async (tx) => {
      await changeOwnPassword(
        tx,
        principal,
        {
          currentPassword: text(form, "currentPassword"),
          newPassword: text(form, "newPassword"),
          confirmPassword: text(form, "confirmPassword"),
        },
        { minLength, context },
      );
    });
  } catch (error) {
    return toState(error, "The password could not be changed.");
  }

  revalidatePath("/account");
  return {
    notice:
      "Password changed. Every other session has been signed out; this one is still yours.",
  };
}

export async function beginEnrolmentAction(
  _prev: AccountFormState,
  _form: FormData,
): Promise<AccountFormState> {
  try {
    const principal = await requirePrincipal();
    const db = await getDb();
    const challenge = await beginMfaEnrolment(db, principal);
    return { enrolment: { ...challenge, qrDataUrl: await renderQr(challenge.uri) } };
  } catch (error) {
    return toState(error, "Enrolment could not be started.");
  }
}

export async function confirmEnrolmentAction(
  _prev: AccountFormState,
  form: FormData,
): Promise<AccountFormState> {
  const deviceId = text(form, "deviceId");

  try {
    const principal = await requirePrincipal();
    const db = await getDb();
    const context = await getRequestContext();

    const result = await db.transaction(async (tx) =>
      confirmMfaEnrolment(tx, principal, deviceId, text(form, "code").trim(), context),
    );

    // Deliberately no revalidatePath here. Revalidating re-renders the page, the
    // server sees the account as enrolled, and the panel holding the recovery
    // codes is replaced before anyone has read them — and they are shown exactly
    // once. The panel offers a link that refreshes the page when the user is done
    // with them.
    return {
      notice: "Authenticator enrolled.",
      recoveryCodes: result.recoveryCodes,
    };
  } catch (error) {
    // The challenge is preserved so the user can retype the code rather than
    // starting over with a new secret they would have to scan again.
    const state = toState(error, "The code could not be verified.");
    return {
      ...state,
      enrolment: {
        deviceId,
        secret: text(form, "secret"),
        uri: text(form, "uri"),
        qrDataUrl: text(form, "qrDataUrl"),
        usingDevelopmentKey: text(form, "usingDevelopmentKey") === "true",
      },
    };
  }
}

export async function revokeSessionAction(
  _prev: AccountFormState,
  form: FormData,
): Promise<AccountFormState> {
  const sessionId = text(form, "sessionId");

  try {
    const principal = await requirePrincipal();
    const db = await getDb();

    // Ownership is checked here rather than trusted from the form: a session id
    // in a request body says nothing about whose session it is.
    const owned = await db.execute<{ id: string }>(sql`
      SELECT id FROM auth.session WHERE id = ${sessionId} AND user_id = ${principal.userId}
    `);
    if (!owned.rows?.[0]) return { error: "That session is not yours." };

    await revokeSession(db, sessionId, principal.userId);
  } catch (error) {
    return toState(error, "The session could not be ended.");
  }

  revalidatePath("/account");
  return { notice: "Session ended." };
}
