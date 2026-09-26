import { NextResponse } from "next/server";
import { getDb } from "@cac/db";
import { isUserFacingError, recordEnquiry } from "@cac/core";
import { getRequestContext } from "@/lib/auth";

/**
 * Where the public site's enquiry form posts.
 *
 * The only route in this application that a stranger may write through, which is why it is worth
 * being explicit about what protects it.
 *
 * **Nothing here is trusted.** Every field is trimmed, length-capped and validated in `recordEnquiry`
 * and again by CHECK constraints on the table, so bypassing the form gets you nothing the form
 * would not. Nothing submitted can set a status, an assignment, or a link to a customer or a case:
 * those are different columns, written only by somebody signed in, and a trigger refuses any attempt
 * to edit what an enquirer wrote.
 *
 * **The rate limit is in the database**, counted per address per hour, because a process that
 * restarts or a second instance must not forget.
 *
 * **The body is capped before it is parsed.** A megabyte of JSON should not reach the parser to be
 * rejected afterwards.
 *
 * **No error tells a stranger anything.** A validation message is the visitor's own mistake and is
 * returned; anything else is logged here and answered with a flat refusal, because the difference
 * between "the database is down" and "that constraint failed" is reconnaissance.
 *
 * **CORS is deliberate and narrow.** The public site is a separate origin in development and may be
 * one in production, so the allowed origins are listed in `ENQUIRY_ALLOWED_ORIGINS` and nothing else
 * is echoed back. An unlisted origin gets no CORS headers at all rather than a helpful wildcard.
 */

const MAX_BODY_BYTES = 16 * 1024;

/** Origins the browser form may post from. Same-origin needs no entry. */
function allowedOrigins(): string[] {
  const configured = process.env.ENQUIRY_ALLOWED_ORIGINS ?? "";
  const listed = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  // The public site's dev server, so the form works end to end on a developer's machine without any
  // configuration. Not added in production: there, the origins are named explicitly.
  if (process.env.NODE_ENV === "development") {
    listed.push("http://localhost:5173", "http://127.0.0.1:5173");
  }
  return listed;
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

export async function POST(request: Request) {
  const cors = corsHeaders(request.headers.get("origin"));

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: "That message is too long to send. Please shorten it." },
      { status: 413, headers: cors },
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { ok: false, error: "That message is too long to send. Please shorten it." },
        { status: 413, headers: cors },
      );
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { ok: false, error: "That could not be read." },
      { status: 400, headers: cors },
    );
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { ok: false, error: "That could not be read." },
      { status: 400, headers: cors },
    );
  }

  const field = (name: string): string | null => {
    const value = (body as Record<string, unknown>)[name];
    return typeof value === "string" ? value : null;
  };

  // A field no human fills in. A script that fills every input gives itself away, and the visitor is
  // told the enquiry was received either way — telling a spammer which check caught them is how the
  // next attempt gets past it.
  if ((field("website") ?? "").trim() !== "") {
    return NextResponse.json({ ok: true, reference: null }, { status: 202, headers: cors });
  }

  const context = await getRequestContext();

  try {
    const db = await getDb();
    const { reference } = await recordEnquiry(
      db,
      {
        name: field("name") ?? "",
        email: field("email"),
        phone: field("phone"),
        company: field("company"),
        service: field("service"),
        message: field("message") ?? "",
        source: "website",
        ip: context.ip,
        userAgent: context.userAgent,
      },
      context,
    );

    return NextResponse.json({ ok: true, reference }, { status: 201, headers: cors });
  } catch (error) {
    if (isUserFacingError(error)) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 400, headers: cors },
      );
    }
    console.error("[enquiries] an enquiry could not be recorded:", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          "Something went wrong at our end and the enquiry was not saved. Please call or email us " +
          "instead — the details are on this page.",
      },
      { status: 500, headers: cors },
    );
  }
}
