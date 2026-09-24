import { sql } from "drizzle-orm";
import type { Executor } from "@cac/db";
import { AUDIT, writeAudit, type AuditContext } from "./audit.js";
import { requireCapability, type Principal } from "./authz.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";

/**
 * The chart of accounts.
 *
 * Read side and write side. The default chart ships in @cac/db (coa.ts); this
 * module is how it is browsed and amended afterwards.
 *
 * Two rules shape everything here. An account that has been posted to cannot
 * change its type or become a heading, because either would silently restate
 * reports that have already been produced. And system accounts — the ones other
 * modules resolve by code — cannot be renumbered or deactivated at all. Both are
 * enforced by triggers as well; the checks below exist to say so in English.
 */

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export const ACCOUNT_TYPES: Array<{ value: AccountType; label: string; side: "debit" | "credit" }> = [
  { value: "ASSET", label: "Asset", side: "debit" },
  { value: "LIABILITY", label: "Liability", side: "credit" },
  { value: "EQUITY", label: "Equity", side: "credit" },
  { value: "REVENUE", label: "Revenue", side: "credit" },
  { value: "EXPENSE", label: "Expense", side: "debit" },
];

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  parentId: string | null;
  normalSide: "debit" | "credit";
  isPostable: boolean;
  isActive: boolean;
  isSystem: boolean;
  isContra: boolean;
  currency: string;
  description: string | null;
  /** Depth in the tree, for indenting a flat list. */
  depth: number;
  /** Number of posted lines. Zero means the account is still free to change. */
  postings: number;
}

type RawAccount = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  parent_id: string | null;
  normal_side: "debit" | "credit";
  is_postable: boolean;
  is_active: boolean;
  is_system: boolean;
  is_contra: boolean;
  currency: string;
  description: string | null;
  depth: number;
  postings: number;
};

const toAccount = (row: RawAccount): AccountRow => ({
  id: row.id,
  code: row.code,
  name: row.name,
  type: row.type,
  subtype: row.subtype,
  parentId: row.parent_id,
  normalSide: row.normal_side,
  isPostable: row.is_postable,
  isActive: row.is_active,
  isSystem: row.is_system,
  isContra: row.is_contra,
  currency: String(row.currency).trim(),
  description: row.description,
  depth: Number(row.depth),
  postings: Number(row.postings),
});

/**
 * The whole chart, in code order, with each account's depth.
 *
 * Depth comes from a recursive walk of `parent_id` rather than from counting
 * digits in the code. Codes are a convention users can break; the tree is the
 * structure the reports actually follow.
 */
export async function listAccounts(
  db: Executor,
  options: { includeInactive?: boolean } = {},
): Promise<AccountRow[]> {
  const result = await db.execute<RawAccount>(sql`
    WITH RECURSIVE tree AS (
      SELECT a.id, 0 AS depth, a.code AS path
        FROM accounting.account a
       WHERE a.parent_id IS NULL
      UNION ALL
      SELECT a.id, t.depth + 1, t.path || '/' || a.code
        FROM accounting.account a
        JOIN tree t ON a.parent_id = t.id
    )
    SELECT a.id, a.code, a.name, a.type, a.subtype, a.parent_id, a.normal_side,
           a.is_postable, a.is_active, a.is_system, a.is_contra, a.currency, a.description,
           t.depth,
           (SELECT count(*) FROM accounting.journal_line l WHERE l.account_id = a.id)::int AS postings
      FROM accounting.account a
      JOIN tree t ON t.id = a.id
     WHERE ${options.includeInactive ? sql`true` : sql`a.is_active`}
     ORDER BY t.path
  `);
  return (result.rows ?? []).map(toAccount);
}

/** Postable, active accounts only — what a journal line may choose from. */
export async function listPostableAccounts(db: Executor): Promise<AccountRow[]> {
  const all = await listAccounts(db);
  return all.filter((a) => a.isPostable);
}

export async function getAccount(db: Executor, idOrCode: string): Promise<AccountRow | null> {
  const all = await listAccounts(db, { includeInactive: true });
  return all.find((a) => a.id === idOrCode || a.code === idOrCode) ?? null;
}

export interface AccountInput {
  code: string;
  name: string;
  type: AccountType;
  parentCode?: string | null;
  subtype?: string | null;
  isPostable?: boolean;
  isContra?: boolean;
  description?: string | null;
}

export async function createAccount(
  db: Executor,
  principal: Principal,
  input: AccountInput,
  context?: AuditContext,
): Promise<{ id: string }> {
  requireCapability(principal, "accounting.coa.manage");

  const code = input.code.trim();
  const name = input.name.trim();

  if (!/^[0-9A-Za-z._-]{2,20}$/.test(code)) {
    throw new ValidationError(
      "An account code is 2 to 20 characters, using letters, digits, dot, dash or underscore.",
      "code",
    );
  }
  if (name.length < 2) throw new ValidationError("Give the account a name.", "name");
  if (!ACCOUNT_TYPES.some((t) => t.value === input.type)) {
    throw new ValidationError("Choose an account type.", "type");
  }

  const clash = await db.execute<{ name: string }>(sql`
    SELECT name FROM accounting.account WHERE code = ${code}
  `);
  if (clash.rows?.[0]) {
    throw new ConflictError(`Account ${code} already exists ("${clash.rows[0].name}").`);
  }

  let parentId: string | null = null;
  if (input.parentCode) {
    const parent = await db.execute<{ id: string; type: AccountType; is_postable: boolean; code: string; name: string }>(
      sql`SELECT id, type, is_postable, code, name FROM accounting.account WHERE code = ${input.parentCode}`,
    );
    const found = parent.rows?.[0];
    if (!found) throw new ValidationError(`There is no account "${input.parentCode}".`, "parentCode");
    if (found.type !== input.type) {
      // A revenue account under an expense heading would break every report
      // that sums by heading.
      throw new ValidationError(
        `${found.code} ${found.name} is a ${found.type.toLowerCase()} heading. A ${input.type.toLowerCase()} account cannot sit under it.`,
        "parentCode",
      );
    }
    parentId = found.id;
  }

  const side = ACCOUNT_TYPES.find((t) => t.value === input.type)!.side;
  const normalSide = input.isContra ? (side === "debit" ? "credit" : "debit") : side;

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO accounting.account
      (code, name, type, subtype, parent_id, normal_side, is_postable, is_contra, description, created_by)
    VALUES (
      ${code}, ${name}, ${input.type}, ${input.subtype?.trim() || null}, ${parentId},
      ${normalSide}, ${input.isPostable ?? true}, ${input.isContra ?? false},
      ${input.description?.trim() || null}, ${principal.userId}
    )
    RETURNING id
  `);
  const id = created.rows![0]!.id;

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ACCOUNT_CREATED,
    entityType: "account",
    entityId: id,
    newValues: { code, name, type: input.type, parentCode: input.parentCode ?? null, normalSide },
  });

  return { id };
}

/**
 * Renames an account and edits its description.
 *
 * Deliberately narrow. Type, side, parent and code are not editable once the
 * account exists: every one of them changes the meaning of history. The correct
 * move for a wrongly-typed account is to deactivate it and create the right one,
 * which leaves both visible.
 */
export async function updateAccount(
  db: Executor,
  principal: Principal,
  accountId: string,
  input: { name: string; subtype?: string | null; description?: string | null },
  context?: AuditContext,
): Promise<void> {
  requireCapability(principal, "accounting.coa.manage");

  const existing = await db.execute<{ code: string; name: string; description: string | null }>(sql`
    SELECT code, name, description FROM accounting.account WHERE id = ${accountId}
  `);
  const account = existing.rows?.[0];
  if (!account) throw new NotFoundError("That account no longer exists.");

  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Give the account a name.", "name");

  await db.execute(sql`
    UPDATE accounting.account
       SET name = ${name}, subtype = ${input.subtype?.trim() || null},
           description = ${input.description?.trim() || null}, updated_by = ${principal.userId}
     WHERE id = ${accountId}
  `);

  await writeAudit(db, {
    ...context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: AUDIT.ACCOUNT_UPDATED,
    entityType: "account",
    entityId: accountId,
    oldValues: { code: account.code, name: account.name, description: account.description },
    newValues: { code: account.code, name, description: input.description ?? null },
  });
}

/**
 * Takes an account out of use, or puts it back.
 *
 * Never a delete. An account with history is part of the record; an account
 * without history still appears in an audit trail as something that was created.
 * Deactivating hides it from the pickers and leaves its postings intact.
 */
export async function setAccountActive(
  db: Executor,
  principal: Principal,
  accountId: string,
  isActive: boolean,
  options: { reason?: string | null; context?: AuditContext } = {},
): Promise<void> {
  requireCapability(principal, "accounting.coa.manage");

  const existing = await db.execute<{ code: string; name: string; is_active: boolean; is_system: boolean }>(sql`
    SELECT code, name, is_active, is_system FROM accounting.account WHERE id = ${accountId}
  `);
  const account = existing.rows?.[0];
  if (!account) throw new NotFoundError("That account no longer exists.");
  if (account.is_active === isActive) return;

  if (account.is_system && !isActive) {
    throw new ConflictError(
      `${account.code} ${account.name} is a system account. Other parts of the platform post to it, so it cannot be taken out of use.`,
    );
  }

  if (!isActive) {
    const children = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM accounting.account
       WHERE parent_id = ${accountId} AND is_active
    `);
    if ((children.rows?.[0]?.count ?? 0) > 0) {
      throw new ConflictError(
        `${account.code} still has active accounts under it. Take those out of use first.`,
      );
    }
  }

  await db.execute(sql`
    UPDATE accounting.account SET is_active = ${isActive}, updated_by = ${principal.userId}
     WHERE id = ${accountId}
  `);

  await writeAudit(db, {
    ...options.context,
    actorUserId: principal.userId,
    actorLabel: principal.email,
    action: isActive ? AUDIT.ACCOUNT_REACTIVATED : AUDIT.ACCOUNT_DEACTIVATED,
    entityType: "account",
    entityId: accountId,
    oldValues: { code: account.code, isActive: account.is_active },
    newValues: { code: account.code, isActive },
    reason: options.reason ?? null,
  });
}
