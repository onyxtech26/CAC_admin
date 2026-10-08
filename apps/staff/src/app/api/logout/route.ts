import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { revokeSession } from "@cac/core";
import { clearSessionCookie, getPrincipal } from "@/lib/auth";

const PUBLIC_HOME_URL = "http://localhost:5173/";

/**
 * Sign out route. Brings the user back to the main public website home.
 */
export async function POST() {
  const principal = await getPrincipal();
  if (principal && principal.sessionId !== "dev-bypass-session") {
    const db = await getDb();
    await revokeSession(db, principal.sessionId, principal.userId).catch(() => {});
  }
  await clearSessionCookie();
  return NextResponse.redirect(new URL(PUBLIC_HOME_URL), { status: 303 });
}

export async function GET() {
  await clearSessionCookie();
  return NextResponse.redirect(new URL(PUBLIC_HOME_URL), { status: 303 });
}
