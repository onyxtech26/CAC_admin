import { redirect } from "next/navigation";

/**
 * MFA challenge is currently bypassed in dev/testing mode.
 */
export default function MfaPage() {
  redirect("/");
}
