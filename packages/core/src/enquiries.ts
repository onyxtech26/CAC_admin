import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { allocateDocumentNumber } from "./sequence.js";

/**
 * Enquiries from the public site.
 *
 * Every primary call to action on the website pointed at a page with no form on it, so a visitor who
 * clicked "Start Investigation" arrived somewhere they could only leave from. This is the other end
 * of the form that now exists.
 *
 * **One function here is called by strangers.** `recordEnquiry` takes no principal, because there is
 * nobody signed in; everything it is given is somebody else's text typed into a form on the internet.
 * That shapes the whole module:
 *
 *  - Every field is trimmed, length-capped and validated here as well as by a CHECK constraint, so
 *    the answer to "what if the caller skips the UI" is the same answer.
 *  - Nothing submitted can set a status, an assignment or a link to a customer. Those are separate
 *    columns written only by somebody signed in, and the database refuses to let the submitted ones
 *    be edited at all.
 *  - The rate limit is counted in the database rather than in memory, because a server that is
 *    restarted or scaled to two instances must not forget.
 *  - No reply is sent from here and none is promised. The platform has no mail transport, and a form
 *    that claims "we will email you shortly" when nothing will is worse than one that says what
 *    actually happens: the enquiry is on a screen the firm reads.
 */

export type EnquiryStatus =
  | "new"
  | "in_progress"
  | "answered"
  | "converted"
  | "spam"
  | "closed";

export interface EnquiryInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  service?: string | null;
  message: string;
  /** Where it came from: the website form, or something recorded by hand. */
  source?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface EnquiryView {
  id: string;
  reference: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  service: string | null;
  message: string;
  source: string;
  status: EnquiryStatus;
  assignedToName: string | null;
  handledAt: string | null;
  handledByName: string | null;
  handlingNote: string | null;
  customerId: string | null;
  caseId: string | null;
  createdAt: string;
}

/** What an enquiry may say, in the shape the column can hold. */
const LIMITS = {
  name: 120,
  email: 254,
  phone: 40,
  company: 160,
  service: 120,
  message: 4000,
  userAgent: 400,
} as const;

/**
 * How many enquiries one address may send in an hour.
 *
 * Generous for a real office behind a single NAT address and far below what makes spamming a form
 * worthwhile. The check is a query rather than a counter in memory: a process that restarts, or a
 * second instance, must not start the count again.
 */
export const ENQUIRIES_PER_ADDRESS_PER_HOUR = 5;

function cap(value: string | null | undefined, limit: number, field: string, label: string): string | null {
  const text = (value ?? "").trim();
  if (text === "") return null;
  if (text.length > limit) {
    throw new ValidationError(`${label} is longer than ${limit} characters.`, field);
  }
  return text;
}

/**
 * Records an enquiry from the public site.
 *
 * Deliberately takes no `Principal`: there is nobody signed in, and adding one would invite somebody
 * to call it with a staff session and believe the enquiry had been vetted.
 */
export async function recordEnquiry(
  db: Executor,
  input: EnquiryInput,
  context?: AuditContext,
): Promise<{ id: string; reference: string }> {
  // Before the validation, not after. The limit counts what has been *stored*, so a visitor who
  // makes five typos is not locked out — and a flood is turned away before anything is parsed or
  // checked, which is the point of having a limit at all.
  if (input.ip) {
    const recent = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM org.enquiry
       WHERE ip = ${input.ip}::inet AND created_at > now() - interval '1 hour'
    `);
    if (Number(recent.rows?.[0]?.n ?? "0") >= ENQUIRIES_PER_ADDRESS_PER_HOUR) {
      throw new ConflictError(
        "Several enquiries have already come from this connection in the last hour. Give us a " +
          "little time to answer those, or call the office.",
      );
    }
  }

  const name = cap(input.name, LIMITS.name, "name", "Your name");
  if (!name) throw new ValidationError("Tell us your name, so we know who is asking.", "name");

  const message = cap(input.message, LIMITS.message, "message", "The message");
  if (!message) {
    throw new ValidationError("Tell us what you need, in a sentence or two.", "message");
  }

  const email = cap(input.email, LIMITS.email, "email", "The email address");
  const phone = cap(input.phone, LIMITS.phone, "phone", "The phone number");

  // Shape only. A stricter pattern rejects addresses that work, and the real check is whether a reply
  // reaches them — which nothing here can know.
  if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    throw new ValidationError("That email address does not look right.", "email");
  }
  if (!email && !phone) {
    throw new ValidationError(
      "Leave an email address or a phone number, or there is no way to answer you.",
      "email",
    );
  }

  const reference = await allocateDocumentNumber(db, "enquiry");

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO org.enquiry
      (reference, name, email, phone, company, service, message, source, ip, user_agent)
    VALUES (${reference}, ${name}, ${email}, ${phone},
            ${cap(input.company, LIMITS.company, "company", "The company")},
            ${cap(input.service, LIMITS.service, "service", "The service")},
            ${message}, ${input.source?.trim() || "website"},
            ${input.ip ?? null}, ${cap(input.userAgent, LIMITS.userAgent, "userAgent", "The browser")})
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  // Audited with no actor, which is the truth: nobody signed in did this. The name and message are
  // left out — they are in the row, and copying somebody's message into an append-only table that
  // cannot be scrubbed is how a request to be forgotten becomes impossible to honour.
  await writeAudit(db, {
    ...context,
    actorUserId: null,
    actorLabel: "public website",
    action: AUDIT.ENQUIRY_RECEIVED,
    entityType: "enquiry",
    entityId: id,
    newValues: { reference, service: input.service ?? null, source: input.source ?? "website" },
  });

  return { id, reference };
}

export async function listEnquiries(
  db: Executor,
  principal: Principal,
  options: { status?: EnquiryStatus; limit?: number } = {},
): Promise<EnquiryView[]> {
  requireCapability(principal, "crm.enquiry.view");

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT e.*, a.full_name AS assigned_name, h.full_name AS handled_name
      FROM org.enquiry e
      LEFT JOIN auth."user" a ON a.id = e.assigned_to
      LEFT JOIN auth."user" h ON h.id = e.handled_by
     WHERE (${options.status ?? null}::text IS NULL OR e.status = ${options.status ?? null})
     ORDER BY e.created_at DESC
     LIMIT ${Math.min(Math.max(options.limit ?? 100, 1), 500)}
  `);

  return (result.rows ?? []).map(toView);
}

export async function getEnquiry(
  db: Executor,
  principal: Principal,
  enquiryId: string,
): Promise<EnquiryView | null> {
  requireCapability(principal, "crm.enquiry.view");

  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT e.*, a.full_name AS assigned_name, h.full_name AS handled_name
      FROM org.enquiry e
      LEFT JOIN auth."user" a ON a.id = e.assigned_to
      LEFT JOIN auth."user" h ON h.id = e.handled_by
     WHERE e.id = ${enquiryId}
  `);
  const row = result.rows?.[0];
  return row ? toView(row) : null;
}

/**
 * Records what the firm did about an enquiry.
 *
 * Only the handling columns. What the enquirer wrote is untouchable — the database enforces that
 * too — because "answered" achieved by rewriting the question is not an answer.
 */
export async function handleEnquiry(
  db: Executor,
  principal: Principal,
  enquiryId: string,
  input: {
    status: EnquiryStatus;
    note?: string | null;
    assignedTo?: string | null;
    customerId?: string | null;
    caseId?: string | null;
  },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "crm.enquiry.manage");

  const existing = await db.execute<{ status: string; reference: string }>(
    sql`SELECT status, reference FROM org.enquiry WHERE id = ${enquiryId} FOR UPDATE`,
  );
  const enquiry = existing.rows?.[0];
  if (!enquiry) throw new NotFoundError("That enquiry no longer exists.");

  const closing = input.status !== "new" && input.status !== "in_progress";
  if (input.status === "spam" && !input.note?.trim()) {
    throw new ValidationError(
      "Say why this is being marked as spam. It is a judgement about somebody's message, and the " +
        "next person should be able to see the reason.",
      "note",
    );
  }

  await db.execute(sql`
    UPDATE org.enquiry
       SET status = ${input.status},
           handling_note = ${input.note?.trim() || null},
           assigned_to = ${input.assignedTo ?? null},
           customer_id = ${input.customerId ?? null},
           case_id = ${input.caseId ?? null},
           handled_at = ${closing ? sql`now()` : sql`NULL`},
           handled_by = ${closing ? principal.userId : null}
     WHERE id = ${enquiryId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ENQUIRY_HANDLED,
    entityType: "enquiry",
    entityId: enquiryId,
    oldValues: { status: enquiry.status },
    newValues: { reference: enquiry.reference, status: input.status },
    reason: input.note ?? null,
  });
}

function toView(row: Record<string, unknown>): EnquiryView {
  return {
    id: String(row.id),
    reference: String(row.reference),
    name: String(row.name),
    email: (row.email as string) ?? null,
    phone: (row.phone as string) ?? null,
    company: (row.company as string) ?? null,
    service: (row.service as string) ?? null,
    message: String(row.message),
    source: String(row.source),
    status: row.status as EnquiryStatus,
    assignedToName: (row.assigned_name as string) ?? null,
    handledAt: row.handled_at ? new Date(String(row.handled_at)).toISOString() : null,
    handledByName: (row.handled_name as string) ?? null,
    handlingNote: (row.handling_note as string) ?? null,
    customerId: (row.customer_id as string) ?? null,
    caseId: (row.case_id as string) ?? null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}
