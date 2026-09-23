"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@cac/db";
import { DEFAULT_LOGIN_POLICY, completeMfa, login } from "@cac/core";
import { getRequestContext, getSessionToken, setSessionCookie } from "@/lib/auth";

export interface FormState {
  error?: string;
  notice?: string;
}

const LoginInput = z.object({
  email: z.string().trim().min(1, "Enter your email address.").max(255).email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password.").max(1024),
});

/**
 * Sign in.
 *
 * Every failure returns the same message. Distinguishing "no such account"
 * from "wrong password" would let anyone enumerate CAC's staff directory from
 * the login form, and the value to a legitimate user who has mistyped is
 * nil — they retype either way.
 */
export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = LoginInput.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the details and try again." };
  }

  const db = await getDb();
  const ctx = await getRequestContext();
  const result = await login(db, parsed.data.email, parsed.data.password, DEFAULT_LOGIN_POLICY, ctx);

  switch (result.status) {
    case "ok":
      await setSessionCookie(result.token, DEFAULT_LOGIN_POLICY.absoluteHours);
      redirect("/");

    case "mfa_required":
      await setSessionCookie(result.token, DEFAULT_LOGIN_POLICY.absoluteHours);
      redirect("/login/mfa");

    case "locked": {
      const minutes = Math.max(1, Math.ceil((result.until.getTime() - Date.now()) / 60_000));
      return {
        error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      };
    }

    case "suspended":
      // Safe to be specific: the password was correct, so this is the account
      // holder, and telling them to contact an administrator is more useful
      // than a generic refusal.
      return { error: "This account is suspended. Contact an administrator." };

    default:
      return { error: "Those details are not correct." };
  }
}

const MfaInput = z.object({
  code: z
    .string()
    .trim()
    .min(6, "Enter the 6-digit code, or a recovery code.")
    .max(20),
});

export async function verifyMfa(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = MfaInput.safeParse({ code: formData.get("code") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter the code from your authenticator." };
  }

  const token = await getSessionToken();
  if (!token) redirect("/login");

  const db = await getDb();
  const ctx = await getRequestContext();
  const ok = await completeMfa(db, token, parsed.data.code, ctx);

  if (!ok) return { error: "That code is not correct or has expired." };
  redirect("/");
}
