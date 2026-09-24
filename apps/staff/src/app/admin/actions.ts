"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@cac/db";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
  assignRole,
  createUser,
  resetMfa,
  resetPassword,
  revokeRole,
  setSetting,
  setUserStatus,
} from "@cac/core";
import { getRequestContext, requireCapability } from "@/lib/auth";

/**
 * Administration actions.
 *
 * Same shape as the accounting actions: authenticate, authorise, transact, audit.
 * The rules — no self-escalation, no locking out the last administrator, a
 * mandatory reason for clearing someone's second factor — live in @cac/core/users
 * so they hold no matter what calls them.
 */

export interface AdminFormState {
  error?: string;
  field?: string;
  notice?: string;
  /**
   * A generated password, shown once.
   *
   * Returned to the browser and never stored in readable form. It is not emailed
   * because this platform has no outbound mail path yet, and a send that silently
   * fails is worse than handing it over in person.
   */
  oneTimePassword?: string;
  oneTimePasswordFor?: string;
}

function toState(error: unknown, fallback: string): AdminFormState {
  if (error instanceof ValidationError) return { error: error.message, field: error.field };
  if (error instanceof ConflictError || error instanceof NotFoundError) {
    return { error: error.message };
  }
  if (error instanceof AuthorizationError || error instanceof AuthenticationError) {
    return { error: error.message };
  }
  console.error("[admin] unexpected error:", error);
  return { error: fallback };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;

export async function createUserAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const email = text(form, "email");
  const roles = form.getAll("roles").map(String).filter(Boolean);

  try {
    const principal = await requireCapability("admin.user.manage");
    const db = await getDb();
    const context = await getRequestContext();

    // Roles are only granted here if the caller may grant them at all; createUser
    // routes each one through assignRole, which applies the no-self-escalation
    // rule and audits it separately.
    const result = await db.transaction(async (tx) =>
      createUser(
        tx,
        principal,
        {
          email,
          fullName: text(form, "fullName"),
          roles: principal.capabilities.has("admin.role.manage") ? roles : [],
          mfaEnforced: form.get("mfaEnforced") !== "off",
        },
        context,
      ),
    );

    revalidatePath("/admin/users");
    return {
      notice: `Account created for ${email}.`,
      oneTimePassword: result.password,
      oneTimePasswordFor: email,
    };
  } catch (error) {
    return toState(error, "The account could not be created.");
  }
}

export async function changeUserStatusAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const status = text(form, "status") === "suspended" ? "suspended" : "active";

  try {
    const principal = await requireCapability("admin.user.manage");
    const db = await getDb();
    const context = await getRequestContext();
    await db.transaction(async (tx) => {
      await setUserStatus(tx, principal, text(form, "userId"), status, {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toState(error, "The account could not be changed.");
  }

  revalidatePath("/admin/users");
  return { notice: status === "suspended" ? "Account suspended." : "Account reactivated." };
}

export async function resetPasswordAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const principal = await requireCapability("admin.user.manage");
    const db = await getDb();
    const context = await getRequestContext();
    const result = await db.transaction(async (tx) =>
      resetPassword(tx, principal, text(form, "userId"), {
        reason: optional(form, "reason"),
        context,
      }),
    );

    revalidatePath("/admin/users");
    return {
      notice: "A new one-time password has been issued and every session ended.",
      oneTimePassword: result.password,
      oneTimePasswordFor: text(form, "email"),
    };
  } catch (error) {
    return toState(error, "The password could not be reset.");
  }
}

export async function resetMfaAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  try {
    const principal = await requireCapability("admin.user.manage");
    const db = await getDb();
    const context = await getRequestContext();
    await db.transaction(async (tx) => {
      await resetMfa(tx, principal, text(form, "userId"), {
        reason: text(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toState(error, "The authenticator could not be removed.");
  }

  revalidatePath("/admin/users");
  return { notice: "Authenticator removed. The person can enrol a new one at next sign-in." };
}

export async function changeRoleAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const grant = text(form, "grant") === "true";
  const role = text(form, "role");

  try {
    const principal = await requireCapability("admin.role.manage");
    const db = await getDb();
    const context = await getRequestContext();
    await db.transaction(async (tx) => {
      if (grant) await assignRole(tx, principal, text(form, "userId"), role, context);
      else
        await revokeRole(tx, principal, text(form, "userId"), role, {
          reason: optional(form, "reason"),
          context,
        });
    });
  } catch (error) {
    return toState(error, "The role could not be changed.");
  }

  revalidatePath("/admin/users");
  revalidatePath("/admin/roles");
  return { notice: grant ? `${role} granted.` : `${role} revoked.` };
}

/**
 * Confirms or changes a setting.
 *
 * `value` arrives as JSON text so booleans, numbers, arrays and nulls all go
 * through one field. Invalid JSON is refused rather than stored as a string that
 * would later be read as the wrong type.
 */
export async function saveSettingAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const key = text(form, "key");
  const raw = text(form, "value");

  let value: unknown;
  try {
    value = raw === "" ? null : JSON.parse(raw);
  } catch {
    return {
      error:
        'That is not a valid value. Text needs quotes ("Asia/Kuala_Lumpur"), numbers and true/false do not, and a list looks like [30, 60, 90].',
      field: "value",
    };
  }

  try {
    const principal = await requireCapability("admin.settings.manage");
    const db = await getDb();
    const context = await getRequestContext();
    await db.transaction(async (tx) => {
      await setSetting(tx, principal, key, value, {
        reason: optional(form, "reason"),
        context,
      });
    });
  } catch (error) {
    return toState(error, "The setting could not be changed.");
  }

  revalidatePath("/admin/settings");
  return { notice: `${key} updated.` };
}
