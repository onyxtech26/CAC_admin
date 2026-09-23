import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { revokeSession } from "@cac/core";
import { clearSessionCookie, getPrincipal } from "@/lib/auth";

/**
 * Sign out.
 *
 * POST only: a GET logout can be triggered by any <img> on any page, which is
 * a nuisance rather than a vulnerability, but there is no reason to allow it.
 * The session is revoked server-side, not merely forgotten by the browser.
 */
export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (principal) {
    const db = await getDb();
    await revokeSession(db, principal.sessionId, principal.userId);
  }
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
