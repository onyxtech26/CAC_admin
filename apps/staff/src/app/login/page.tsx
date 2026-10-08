import { redirect } from "next/navigation";

/**
 * Login is currently bypassed in dev/testing mode so you can test the admin
 * system dashboard and all features directly without login interruptions.
 */
export default function LoginPage() {
  redirect("/");
}
