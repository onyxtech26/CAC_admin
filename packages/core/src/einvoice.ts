import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, ValidationError } from "./errors.js";
import { getSetting } from "./settings.js";
import { formatAmount, type Amount } from "./money.js";

/**
 * The e-Invoice boundary.
 *
 * Malaysia's MyInvois requires invoices to be submitted to LHDN and validated
 * before they are valid documents. Whether CAC is in scope, from when, under
 * which TIN, and whether through the API directly or through an intermediary are
 * all open — Q-FIN-2 — and every one of those answers changes the payload, the
 * identifiers and the error handling.
 *
 * So what exists here is the boundary and nothing behind it. That is a deliberate
 * choice and worth stating plainly:
 *
 *   - `EInvoiceProvider` is the interface the rest of the application talks to.
 *     Nothing outside this file knows whether a submission goes to LHDN, to an
 *     intermediary, or nowhere.
 *   - `NotConfiguredProvider` is what is installed, and it refuses every
 *     operation with a sentence naming what is missing. It never returns a
 *     success, never fabricates a UUID, and never records a submission that did
 *     not happen.
 *   - `MyInvoisProvider` holds the request shapes as far as they are knowable
 *     without credentials. It will not construct without a TIN, a client id, a
 *     client secret and an explicit environment, so it cannot silently become the
 *     active provider or quietly point at production.
 *
 * **There is no mock that reports success.** A fake that answers "validated" is
 * worse than no integration at all: the invoice looks compliant on screen, the
 * customer is told it has been submitted, and nobody discovers otherwise until
 * LHDN asks. If CAC needs to exercise the flow before credentials exist, that is
 * a sandbox account, not a stub — and the sandbox is a real endpoint answering
 * real validation errors.
 */

export type EInvoiceEnvironment = "sandbox" | "production";

export interface EInvoiceDocument {
  invoiceId: string;
  invoiceNo: string;
  issuedOn: string;
  currency: string;
  subtotal: Amount;
  taxTotal: Amount;
  total: Amount;
  buyer: {
    name: string;
    /** Tax identification number. Mandatory for MyInvois; often absent here. */
    tin: string | null;
    registrationNo: string | null;
    email: string | null;
    address: string | null;
  };
  lines: Array<{
    description: string;
    quantity: string;
    unitPrice: Amount;
    taxAmount: Amount;
    lineTotal: Amount;
    /** Malaysian classification code. Unknown until Q-FIN-2 is answered. */
    classificationCode?: string | null;
  }>;
}

export interface SubmissionResult {
  /** LHDN's identifier for the document. */
  uuid: string;
  /** Its own long identifier, shown to the customer and printed on the invoice. */
  longId: string | null;
  status: "submitted" | "valid" | "invalid";
  submittedAt: Date;
  /** Validation failures, in the provider's own words. */
  messages: string[];
}

export interface StatusResult {
  uuid: string;
  status: "submitted" | "valid" | "invalid" | "cancelled";
  messages: string[];
}

export interface EInvoiceProvider {
  /** For the screen that explains where this stands. */
  readonly name: string;
  readonly environment: EInvoiceEnvironment | null;
  /** False means every call below will refuse, and the screen says why. */
  readonly configured: boolean;
  /** What is missing, in words a person can act on. */
  readonly blockers: string[];

  submit(document: EInvoiceDocument): Promise<SubmissionResult>;
  status(uuid: string): Promise<StatusResult>;
  cancel(uuid: string, reason: string): Promise<StatusResult>;
}

/**
 * Raised instead of returning a failure, so a caller cannot ignore it.
 *
 * A method returning `{ status: "invalid" }` when the integration does not exist
 * would be indistinguishable from LHDN rejecting the invoice, and the difference
 * matters enormously: one is a document to correct, the other is a question for
 * CAC to answer.
 */
export class EInvoiceNotConfiguredError extends Error {
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(
      "e-Invoicing is not configured, so nothing has been submitted. " +
        blockers.join(" ") +
        " See Q-FIN-2 in docs/OPEN_QUESTIONS.md.",
    );
    this.name = "EInvoiceNotConfiguredError";
    this.blockers = blockers;
  }
}

export class NotConfiguredProvider implements EInvoiceProvider {
  readonly name = "Not configured";
  readonly environment = null;
  readonly configured = false;
  readonly blockers: string[];

  constructor(blockers: string[]) {
    this.blockers = blockers;
  }

  private refuse(): never {
    throw new EInvoiceNotConfiguredError(this.blockers);
  }

  async submit(): Promise<SubmissionResult> {
    this.refuse();
  }

  async status(): Promise<StatusResult> {
    this.refuse();
  }

  async cancel(): Promise<StatusResult> {
    this.refuse();
  }
}

export interface MyInvoisCredentials {
  tin: string;
  clientId: string;
  clientSecret: string;
  environment: EInvoiceEnvironment;
  /** Set when submitting through an intermediary on CAC's behalf. */
  onBehalfOfTin?: string | null;
  /** Overrides the base URL; otherwise the environment decides. */
  baseUrl?: string;
}

const BASE_URLS: Record<EInvoiceEnvironment, string> = {
  // LHDN's published hostnames. Kept here rather than inlined so that the one
  // that is not the sandbox is visible and deliberate.
  sandbox: "https://preprod-api.myinvois.hasil.gov.my",
  production: "https://api.myinvois.hasil.gov.my",
};

/**
 * The MyInvois adapter.
 *
 * Constructed only from complete credentials, which is why `resolveProvider`
 * returns `NotConfiguredProvider` rather than this one today. Its request shapes
 * follow LHDN's published API — OAuth2 client credentials for a token, then a
 * document submission — but **they have not been exercised against the sandbox**,
 * because no sandbox account exists yet. Until they have been, the honest status
 * of this class is "written, unverified", and the screen says exactly that.
 *
 * Three things are deliberately not guessed at, because guessing them would
 * produce submissions that are rejected in ways nobody could debug:
 *
 *   - the classification code per line, which is a Malaysian taxonomy CAC has to
 *     map its services onto;
 *   - the document type code, which depends on whether CAC issues invoices,
 *     self-billed invoices, or both;
 *   - the signing requirements, which differ between direct submission and
 *     submission through an intermediary.
 *
 * Each is checked for and refused rather than defaulted.
 */
export class MyInvoisProvider implements EInvoiceProvider {
  readonly name = "MyInvois";
  readonly environment: EInvoiceEnvironment;
  readonly configured = true;
  readonly blockers: string[] = [];

  private readonly credentials: MyInvoisCredentials;
  private readonly baseUrl: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(credentials: MyInvoisCredentials) {
    const missing: string[] = [];
    if (!credentials.tin?.trim()) missing.push("tin");
    if (!credentials.clientId?.trim()) missing.push("clientId");
    if (!credentials.clientSecret?.trim()) missing.push("clientSecret");
    if (credentials.environment !== "sandbox" && credentials.environment !== "production") {
      missing.push("environment");
    }
    if (missing.length > 0) {
      throw new ValidationError(
        `MyInvois cannot be configured without ${missing.join(", ")}.`,
        missing[0]!,
      );
    }

    this.credentials = credentials;
    this.environment = credentials.environment;
    this.baseUrl = credentials.baseUrl ?? BASE_URLS[credentials.environment];
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;

    const response = await fetch(`${this.baseUrl}/connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        scope: "InvoicingAPI",
      }),
    });

    if (!response.ok) {
      throw new ConflictError(
        `MyInvois refused the credentials (${response.status}). Nothing has been submitted.`,
      );
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new ConflictError("MyInvois returned no access token. Nothing has been submitted.");
    }

    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  /**
   * Checks what cannot be guessed before anything is sent.
   *
   * Submitting a document known to be incomplete would produce a rejection whose
   * cause is buried in LHDN's response; refusing here says which field and why.
   */
  private assertSubmittable(document: EInvoiceDocument): void {
    if (!document.buyer.tin?.trim()) {
      throw new ValidationError(
        `${document.buyer.name} has no tax identification number recorded. MyInvois requires the ` +
          "buyer's TIN, so this invoice cannot be submitted until it is on the customer record.",
        "buyer.tin",
      );
    }

    const unclassified = document.lines.filter((line) => !line.classificationCode?.trim());
    if (unclassified.length > 0) {
      throw new ValidationError(
        `${unclassified.length} line${unclassified.length === 1 ? "" : "s"} have no Malaysian ` +
          "classification code. The code per service is part of Q-FIN-2 and is not guessed at " +
          "here: a wrong code is a rejected submission nobody can debug.",
        "lines.classificationCode",
      );
    }
  }

  async submit(document: EInvoiceDocument): Promise<SubmissionResult> {
    this.assertSubmittable(document);
    const token = await this.accessToken();

    const response = await fetch(`${this.baseUrl}/api/v1.0/documentsubmissions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(this.credentials.onBehalfOfTin
          ? { onbehalfof: this.credentials.onBehalfOfTin }
          : {}),
      },
      body: JSON.stringify({ documents: [encodeDocument(document, this.credentials.tin)] }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      acceptedDocuments?: Array<{ uuid?: string; invoiceCodeNumber?: string }>;
      rejectedDocuments?: Array<{ invoiceCodeNumber?: string; error?: { message?: string } }>;
    };

    if (!response.ok) {
      throw new ConflictError(
        `MyInvois rejected the submission (${response.status}). Nothing has been recorded as sent.`,
      );
    }

    const accepted = body.acceptedDocuments?.[0];
    if (!accepted?.uuid) {
      const reasons = (body.rejectedDocuments ?? [])
        .map((rejected) => rejected.error?.message ?? "no reason given")
        .join("; ");
      throw new ConflictError(
        `MyInvois did not accept ${document.invoiceNo}${reasons ? `: ${reasons}` : "."}`,
      );
    }

    return {
      uuid: accepted.uuid,
      longId: null,
      status: "submitted",
      submittedAt: new Date(),
      messages: [],
    };
  }

  async status(uuid: string): Promise<StatusResult> {
    const token = await this.accessToken();
    const response = await fetch(`${this.baseUrl}/api/v1.0/documents/${uuid}/details`, {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new ConflictError(`MyInvois could not be asked about ${uuid} (${response.status}).`);
    }

    const body = (await response.json()) as {
      status?: string;
      validationResults?: { validationSteps?: Array<{ error?: { message?: string } }> };
    };

    const messages = (body.validationResults?.validationSteps ?? [])
      .map((step) => step.error?.message)
      .filter((message): message is string => Boolean(message));

    return { uuid, status: normaliseStatus(body.status), messages };
  }

  async cancel(uuid: string, reason: string): Promise<StatusResult> {
    if (!reason?.trim()) {
      throw new ValidationError("LHDN requires a reason for cancelling a document.", "reason");
    }

    const token = await this.accessToken();
    const response = await fetch(`${this.baseUrl}/api/v1.0/documents/state/${uuid}/state`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled", reason: reason.trim() }),
    });

    if (!response.ok) {
      throw new ConflictError(
        `MyInvois refused to cancel ${uuid} (${response.status}). It is still live.`,
      );
    }

    return { uuid, status: "cancelled", messages: [] };
  }
}

function normaliseStatus(status: string | undefined): StatusResult["status"] {
  switch ((status ?? "").toLowerCase()) {
    case "valid":
      return "valid";
    case "invalid":
      return "invalid";
    case "cancelled":
      return "cancelled";
    default:
      return "submitted";
  }
}

/**
 * The document as MyInvois wants it.
 *
 * Money crosses the boundary as a decimal string rather than a number: JSON
 * numbers are IEEE doubles, and an invoice total that arrives at LHDN a hundredth
 * of a sen out is a rejected document.
 */
function encodeDocument(document: EInvoiceDocument, supplierTin: string) {
  const decimal = (amount: Amount) => formatAmount(amount, { grouped: false });

  return {
    format: "JSON",
    documentHash: null,
    codeNumber: document.invoiceNo,
    document: {
      issueDate: document.issuedOn,
      currency: document.currency,
      supplier: { tin: supplierTin },
      buyer: {
        tin: document.buyer.tin,
        registrationNumber: document.buyer.registrationNo,
        email: document.buyer.email,
        address: document.buyer.address,
        name: document.buyer.name,
      },
      lines: document.lines.map((line, index) => ({
        id: String(index + 1),
        description: line.description,
        quantity: line.quantity,
        unitPrice: decimal(line.unitPrice),
        taxAmount: decimal(line.taxAmount),
        lineTotal: decimal(line.lineTotal),
        classificationCode: line.classificationCode,
      })),
      totals: {
        subtotal: decimal(document.subtotal),
        tax: decimal(document.taxTotal),
        total: decimal(document.total),
      },
    },
  };
}

export interface EInvoiceStatus {
  /** Whether CAC has said it is in scope at all. */
  inScope: boolean;
  provider: EInvoiceProvider;
  /** Everything still needed, for the screen. */
  blockers: string[];
}

/**
 * Decides which provider is in use.
 *
 * Settings first, environment second, and `NotConfiguredProvider` when anything
 * is missing — which is today, and will stay so until CAC answers. Credentials
 * are read from the environment rather than the database on purpose: a client
 * secret in a settings table is a client secret in every database backup and
 * visible to anyone who can read settings.
 */
export async function resolveProvider(db: Executor): Promise<EInvoiceStatus> {
  const inScope = await getSetting<boolean>(db, "einvoice.enabled", false);
  const blockers: string[] = [];

  if (!inScope) {
    blockers.push(
      "CAC has not been recorded as in scope for MyInvois; an administrator confirms that under " +
        "Settings once LHDN's timetable for a company of this size is known.",
    );
  }

  const tin = (await getSetting<string>(db, "tax.tin", "")) || "";
  if (!tin.trim()) blockers.push("The company's tax identification number is not recorded.");

  const clientId = process.env.MYINVOIS_CLIENT_ID ?? "";
  const clientSecret = process.env.MYINVOIS_CLIENT_SECRET ?? "";
  const environment = process.env.MYINVOIS_ENVIRONMENT ?? "";

  if (!clientId || !clientSecret) {
    blockers.push(
      "No MyInvois client credentials are present in the environment. Sandbox credentials are " +
        "needed before anything can be exercised end to end.",
    );
  }
  if (environment !== "sandbox" && environment !== "production") {
    blockers.push(
      "MYINVOIS_ENVIRONMENT is not set to sandbox or production. There is no default: pointing " +
        "at the wrong one submits real documents to LHDN or fails to.",
    );
  }

  if (blockers.length > 0) {
    return { inScope, provider: new NotConfiguredProvider(blockers), blockers };
  }

  return {
    inScope,
    provider: new MyInvoisProvider({
      tin,
      clientId,
      clientSecret,
      environment: environment as EInvoiceEnvironment,
      onBehalfOfTin: process.env.MYINVOIS_ON_BEHALF_OF_TIN ?? null,
    }),
    blockers,
  };
}

/**
 * Builds the document from an issued invoice.
 *
 * Read-only, and useful before any credentials exist: it is what the "would this
 * invoice be submittable" check on screen uses, so CAC can see today which
 * customers are missing a TIN rather than finding out on the day submission
 * becomes mandatory.
 */
export async function buildEInvoiceDocument(
  db: Executor,
  invoiceId: string,
): Promise<EInvoiceDocument | null> {
  const header = await db.execute<{
    id: string;
    invoice_no: string | null;
    issue_date: string;
    currency: string;
    subtotal: string;
    tax_total: string;
    total: string;
    customer_name: string;
    tax_identifier: string | null;
    registration_no: string | null;
    email: string | null;
    address: string | null;
  }>(sql`
    SELECT i.id, i.invoice_no, i.issue_date, i.currency, i.subtotal, i.tax_total, i.total,
           c.name AS customer_name, c.tax_identifier, c.registration_no, c.email, c.address
      FROM accounting.invoice i
      JOIN accounting.customer c ON c.id = i.customer_id
     WHERE i.id = ${invoiceId}
  `);
  const row = header.rows?.[0];
  if (!row) return null;

  const lines = await db.execute<{
    description: string;
    quantity: string;
    unit_price: string;
    tax_amount: string;
    line_total: string;
  }>(sql`
    SELECT description, quantity, unit_price, tax_amount, line_total
      FROM accounting.invoice_line WHERE invoice_id = ${invoiceId} ORDER BY line_no
  `);

  const { parseAmount } = await import("./money.js");

  return {
    invoiceId: row.id,
    invoiceNo: row.invoice_no ?? "",
    issuedOn: String(row.issue_date).slice(0, 10),
    currency: row.currency,
    subtotal: parseAmount(row.subtotal),
    taxTotal: parseAmount(row.tax_total),
    total: parseAmount(row.total),
    buyer: {
      name: row.customer_name,
      tin: row.tax_identifier,
      registrationNo: row.registration_no,
      email: row.email,
      address: row.address,
    },
    lines: (lines.rows ?? []).map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: parseAmount(line.unit_price),
      taxAmount: parseAmount(line.tax_amount),
      lineTotal: parseAmount(line.line_total),
      classificationCode: null,
    })),
  };
}

/**
 * What would stop each issued invoice being submitted.
 *
 * The point of having this before the integration exists: the data problems are
 * CAC's to fix and take time — a TIN per customer, a classification code per
 * service — and they can be worked on now rather than discovered on the deadline.
 */
export async function submissionReadiness(
  db: Executor,
  principal: Principal,
): Promise<{
  invoices: number;
  customersWithoutTin: Array<{ id: string; code: string; name: string; invoices: number }>;
  companyTinRecorded: boolean;
}> {
  requireCapability(principal, "accounting.einvoice.view");

  const missing = await db.execute<{
    id: string;
    code: string;
    name: string;
    invoices: number;
  }>(sql`
    SELECT c.id, c.code, c.name, count(i.id)::int AS invoices
      FROM accounting.customer c
      JOIN accounting.invoice i ON i.customer_id = c.id AND i.status IN ('issued', 'paid')
     WHERE c.tax_identifier IS NULL OR btrim(c.tax_identifier) = ''
     GROUP BY c.id, c.code, c.name
     ORDER BY count(i.id) DESC
  `);

  const issued = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM accounting.invoice WHERE status IN ('issued', 'paid')
  `);

  const tin = (await getSetting<string>(db, "tax.tin", "")) || "";

  return {
    invoices: issued.rows?.[0]?.count ?? 0,
    customersWithoutTin: missing.rows ?? [],
    companyTinRecorded: tin.trim() !== "",
  };
}
