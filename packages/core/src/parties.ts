import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { amountToSql, parseAmount, type Amount } from "./money.js";

/**
 * Customers and suppliers.
 *
 * Kept deliberately thin in this phase: they are the parties invoices and
 * vouchers will be raised against, and nothing here creates a financial entry.
 * The ledger side arrives in phase 3, and it will post through the engine in
 * posting.ts like everything else.
 *
 * Codes are allocated by the user rather than generated. Firms already have
 * customer codes in whatever system they came from, and forcing a new scheme on
 * them makes reconciling the migration harder than it needs to be.
 */

export interface PartyInput {
  code: string;
  name: string;
  registrationNo?: string | null;
  taxIdentifier?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  contactPerson?: string | null;
  paymentTermsDays?: number | null;
  notes?: string | null;
}

export interface CustomerInput extends PartyInput {
  creditLimit?: string | null;
}

export interface SupplierInput extends PartyInput {
  bankName?: string | null;
  bankAccountNo?: string | null;
}

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  email: string | null;
  phone: string | null;
  contactPerson: string | null;
  registrationNo: string | null;
  taxIdentifier: string | null;
  address: string | null;
  paymentTermsDays: number;
  creditLimit: Amount | null;
  isActive: boolean;
  notes: string | null;
}

export interface SupplierRow extends Omit<CustomerRow, "creditLimit"> {
  bankName: string | null;
  /** Shown masked in listings; the full value needs supplier.manage. */
  bankAccountNo: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validate(input: PartyInput): { code: string; name: string; terms: number } {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();

  if (!/^[A-Z0-9._-]{2,20}$/.test(code)) {
    throw new ValidationError(
      "A code is 2 to 20 characters: letters, digits, dot, dash or underscore.",
      "code",
    );
  }
  if (name.length < 2) throw new ValidationError("Enter a name.", "name");
  if (input.email?.trim() && !EMAIL.test(input.email.trim())) {
    throw new ValidationError("That does not look like an email address.", "email");
  }

  const terms = input.paymentTermsDays ?? 30;
  if (!Number.isInteger(terms) || terms < 0 || terms > 365) {
    throw new ValidationError("Payment terms are a whole number of days, 0 to 365.", "paymentTermsDays");
  }

  return { code, name, terms };
}

export async function createCustomer(
  db: Executor,
  principal: Principal,
  input: CustomerInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.customer.manage");
  const { code, name, terms } = validate(input);

  const clash = await db.execute<{ name: string }>(
    sql`SELECT name FROM accounting.customer WHERE code = ${code}`,
  );
  if (clash.rows?.[0]) {
    throw new ConflictError(`Customer ${code} already exists ("${clash.rows[0].name}").`);
  }

  const creditLimit = input.creditLimit?.trim() ? parseAmount(input.creditLimit, "creditLimit") : null;
  if (creditLimit !== null && creditLimit < 0n) {
    throw new ValidationError("A credit limit cannot be negative.", "creditLimit");
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.customer
      (code, name, registration_no, tax_identifier, email, phone, address, contact_person,
       payment_terms_days, credit_limit, notes, created_by)
    VALUES (
      ${code}, ${name}, ${input.registrationNo?.trim() || null}, ${input.taxIdentifier?.trim() || null},
      ${input.email?.trim().toLowerCase() || null}, ${input.phone?.trim() || null},
      ${input.address?.trim() || null}, ${input.contactPerson?.trim() || null},
      ${terms}, ${creditLimit === null ? null : amountToSql(creditLimit)},
      ${input.notes?.trim() || null}, ${principal.userId}
    )
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CUSTOMER_CREATED,
    entityType: "customer",
    entityId: id,
    newValues: { code, name, paymentTermsDays: terms },
  });

  return { id };
}

export async function updateCustomer(
  db: Executor,
  principal: Principal,
  customerId: string,
  input: CustomerInput & { isActive?: boolean },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.customer.manage");
  const { name, terms } = validate(input);

  const before = await db.execute<{ code: string; name: string; payment_terms_days: number }>(
    sql`SELECT code, name, payment_terms_days FROM accounting.customer WHERE id = ${customerId}`,
  );
  const existing = before.rows?.[0];
  if (!existing) throw new NotFoundError("That customer no longer exists.");

  const creditLimit = input.creditLimit?.trim() ? parseAmount(input.creditLimit, "creditLimit") : null;

  await db.execute(sql`
    UPDATE accounting.customer SET
      name = ${name},
      registration_no = ${input.registrationNo?.trim() || null},
      tax_identifier = ${input.taxIdentifier?.trim() || null},
      email = ${input.email?.trim().toLowerCase() || null},
      phone = ${input.phone?.trim() || null},
      address = ${input.address?.trim() || null},
      contact_person = ${input.contactPerson?.trim() || null},
      payment_terms_days = ${terms},
      credit_limit = ${creditLimit === null ? null : amountToSql(creditLimit)},
      notes = ${input.notes?.trim() || null},
      is_active = ${input.isActive ?? true},
      updated_by = ${principal.userId}
    WHERE id = ${customerId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.CUSTOMER_UPDATED,
    entityType: "customer",
    entityId: customerId,
    oldValues: { code: existing.code, name: existing.name, paymentTermsDays: existing.payment_terms_days },
    newValues: { code: existing.code, name, paymentTermsDays: terms },
  });
}

export async function listCustomers(
  db: Executor,
  options: { includeInactive?: boolean; search?: string } = {},
): Promise<CustomerRow[]> {
  const term = options.search?.trim().toLowerCase();
  const result = await db.execute<{
    id: string;
    code: string;
    name: string;
    email: string | null;
    phone: string | null;
    contact_person: string | null;
    registration_no: string | null;
    tax_identifier: string | null;
    address: string | null;
    payment_terms_days: number;
    credit_limit: string | null;
    is_active: boolean;
    notes: string | null;
  }>(sql`
    SELECT * FROM accounting.customer
     WHERE ${options.includeInactive ? sql`true` : sql`is_active`}
       AND ${term ? sql`(lower(name) LIKE ${`%${term}%`} OR lower(code) LIKE ${`%${term}%`})` : sql`true`}
     ORDER BY name
  `);
  return (result.rows ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    email: row.email,
    phone: row.phone,
    contactPerson: row.contact_person,
    registrationNo: row.registration_no,
    taxIdentifier: row.tax_identifier,
    address: row.address,
    paymentTermsDays: row.payment_terms_days,
    creditLimit: row.credit_limit === null ? null : parseAmount(row.credit_limit),
    isActive: row.is_active,
    notes: row.notes,
  }));
}

export async function createSupplier(
  db: Executor,
  principal: Principal,
  input: SupplierInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.supplier.manage");
  const { code, name, terms } = validate(input);

  const clash = await db.execute<{ name: string }>(
    sql`SELECT name FROM accounting.supplier WHERE code = ${code}`,
  );
  if (clash.rows?.[0]) {
    throw new ConflictError(`Supplier ${code} already exists ("${clash.rows[0].name}").`);
  }

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.supplier
      (code, name, registration_no, tax_identifier, email, phone, address, contact_person,
       payment_terms_days, bank_name, bank_account_no, notes, created_by)
    VALUES (
      ${code}, ${name}, ${input.registrationNo?.trim() || null}, ${input.taxIdentifier?.trim() || null},
      ${input.email?.trim().toLowerCase() || null}, ${input.phone?.trim() || null},
      ${input.address?.trim() || null}, ${input.contactPerson?.trim() || null},
      ${terms}, ${input.bankName?.trim() || null}, ${input.bankAccountNo?.trim() || null},
      ${input.notes?.trim() || null}, ${principal.userId}
    )
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.SUPPLIER_CREATED,
    entityType: "supplier",
    entityId: id,
    // The account number is masked by the audit redactor, not stored in full
    // here: a bank detail change is worth recording, the digits are not.
    newValues: { code, name, paymentTermsDays: terms, bank_account: input.bankAccountNo ?? null },
  });

  return { id };
}

export async function updateSupplier(
  db: Executor,
  principal: Principal,
  supplierId: string,
  input: SupplierInput & { isActive?: boolean },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.supplier.manage");
  const { name, terms } = validate(input);

  const before = await db.execute<{
    code: string;
    name: string;
    bank_account_no: string | null;
  }>(sql`SELECT code, name, bank_account_no FROM accounting.supplier WHERE id = ${supplierId}`);
  const existing = before.rows?.[0];
  if (!existing) throw new NotFoundError("That supplier no longer exists.");

  await db.execute(sql`
    UPDATE accounting.supplier SET
      name = ${name},
      registration_no = ${input.registrationNo?.trim() || null},
      tax_identifier = ${input.taxIdentifier?.trim() || null},
      email = ${input.email?.trim().toLowerCase() || null},
      phone = ${input.phone?.trim() || null},
      address = ${input.address?.trim() || null},
      contact_person = ${input.contactPerson?.trim() || null},
      payment_terms_days = ${terms},
      bank_name = ${input.bankName?.trim() || null},
      bank_account_no = ${input.bankAccountNo?.trim() || null},
      notes = ${input.notes?.trim() || null},
      is_active = ${input.isActive ?? true},
      updated_by = ${principal.userId}
    WHERE id = ${supplierId}
  `);

  const bankChanged = (existing.bank_account_no ?? "") !== (input.bankAccountNo?.trim() ?? "");

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.SUPPLIER_UPDATED,
    entityType: "supplier",
    entityId: supplierId,
    oldValues: { code: existing.code, name: existing.name, bank_account: existing.bank_account_no },
    newValues: { code: existing.code, name, bank_account: input.bankAccountNo ?? null },
    // Called out explicitly, because a changed payee account is the classic
    // invoice-redirection fraud and someone should be able to search for it.
    reason: bankChanged ? "Bank account details changed" : null,
  });
}

export async function listSuppliers(
  db: Executor,
  options: { includeInactive?: boolean; search?: string } = {},
): Promise<SupplierRow[]> {
  const term = options.search?.trim().toLowerCase();
  const result = await db.execute<{
    id: string;
    code: string;
    name: string;
    email: string | null;
    phone: string | null;
    contact_person: string | null;
    registration_no: string | null;
    tax_identifier: string | null;
    address: string | null;
    payment_terms_days: number;
    bank_name: string | null;
    bank_account_no: string | null;
    is_active: boolean;
    notes: string | null;
  }>(sql`
    SELECT * FROM accounting.supplier
     WHERE ${options.includeInactive ? sql`true` : sql`is_active`}
       AND ${term ? sql`(lower(name) LIKE ${`%${term}%`} OR lower(code) LIKE ${`%${term}%`})` : sql`true`}
     ORDER BY name
  `);
  return (result.rows ?? []).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    email: row.email,
    phone: row.phone,
    contactPerson: row.contact_person,
    registrationNo: row.registration_no,
    taxIdentifier: row.tax_identifier,
    address: row.address,
    paymentTermsDays: row.payment_terms_days,
    bankName: row.bank_name,
    bankAccountNo: row.bank_account_no,
    isActive: row.is_active,
    notes: row.notes,
  }));
}

/** Last four digits only. Enough to check a payment against, useless to divert one. */
export function maskAccountNumber(value: string | null): string {
  if (!value) return "";
  const trimmed = value.replace(/\s/g, "");
  if (trimmed.length <= 4) return "****";
  return `${"*".repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
}
