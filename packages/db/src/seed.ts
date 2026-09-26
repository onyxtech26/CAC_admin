import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { closeDb, getDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import { ALL_PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "./rbac.js";
import { CHART_OF_ACCOUNTS, SYSTEM_ACCOUNTS, TAX_CODES, type AccountSeed } from "./coa.js";

/**
 * Idempotent seed: roles, the capability catalogue, role bundles, and the
 * configurable defaults recorded in docs/OPEN_QUESTIONS.md.
 *
 * Settings whose real value is not yet known are inserted with
 * `needs_review = true` rather than guessed silently, so the admin screen can
 * list exactly what CAC still has to confirm.
 */

type SettingSeed = {
  key: string;
  value: unknown;
  category: string;
  label: string;
  description?: string;
  needsReview?: boolean;
  requiresApproval?: boolean;
};

const SETTINGS: SettingSeed[] = [
  // Company
  { key: "company.name", value: "Conglomerate Appraisal Consultancy", category: "company", label: "Company name" },
  { key: "company.short_name", value: "CAC", category: "company", label: "Short name" },
  { key: "company.email", value: "admin@conglomerate4u.com", category: "company", label: "Company email" },
  { key: "company.phone", value: "+60 11-5960 1300", category: "company", label: "Company phone" },
  { key: "company.address", value: "85-01, Jalan Wira 2, Taman Tan Sri Yaacob, 81300 Skudai, Johor, Malaysia", category: "company", label: "Registered address" },
  {
    key: "company.registration_no",
    value: null,
    category: "company",
    label: "Company registration number",
    description:
      "The SSM number, printed on invoices. UNSET - a made-up number on a tax invoice is a real problem, so the line is omitted until someone enters it.",
    needsReview: true,
  },
  { key: "company.timezone", value: "Asia/Kuala_Lumpur", category: "company", label: "Timezone" },
  { key: "company.currency", value: "MYR", category: "company", label: "Operating currency" },

  // Accounting — see OPEN_QUESTIONS Q-FIN-1/3/4
  { key: "accounting.fiscal_year_start_month", value: 1, category: "accounting", label: "Fiscal year starts in month", description: "1 = January. Confirm with CAC's accountant.", needsReview: true },
  { key: "accounting.period_length", value: "monthly", category: "accounting", label: "Accounting period length" },
  { key: "accounting.invoice_terms_days", value: 30, category: "accounting", label: "Default invoice payment terms (days)" },
  {
    key: "accounting.quotation_validity_days",
    value: 30,
    category: "accounting",
    label: "Default quotation validity (days)",
    description:
      "Printed on the offer, and — since accepting a lapsed quotation is refused — the date it stops being one. Thirty days is the common convention and nobody's decision, so until this is confirmed a quotation states no validity at all rather than implying a deadline CAC never set.",
    needsReview: true,
  },
  {
    key: "accounting.aging_buckets",
    value: [30, 60, 90],
    category: "accounting",
    label: "AR aging bucket boundaries (days)",
    description:
      "Which invoices a collections conversation starts with. 30/60/90 is the common convention rather than CAC's policy; until it is confirmed the aging report says so on its face.",
    needsReview: true,
  },
  {
    key: "accounting.journal_requires_second_person",
    value: true,
    category: "accounting",
    label: "Manual journals must be posted by a second person",
    description:
      "The standard maker/checker control. Leave it on where two people hold accounting.journal.post. Where only one does, it prevents manual journals being posted at all - switch it off deliberately and every self-posted journal is then flagged as such in the audit trail. See Q-FIN-5.",
    requiresApproval: true,
  },
  {
    key: "accounting.approval_threshold_myr",
    value: null,
    category: "accounting",
    label: "Management approval limit (MYR)",
    description:
      "Above this amount a Director must approve. UNSET — until confirmed, every approval routes to a Director. See Q-FIN-3.",
    needsReview: true,
    requiresApproval: true,
  },
  {
    key: "tax.sst_registered",
    value: false,
    category: "tax",
    label: "SST registered",
    description:
      "UNCONFIRMED. While false, invoices show no tax. Do not enable without the registration number and effective date. See Q-FIN-1.",
    needsReview: true,
    requiresApproval: true,
  },
  { key: "tax.sst_registration_no", value: null, category: "tax", label: "SST registration number", needsReview: true, requiresApproval: true },
  {
    key: "tax.tin",
    value: null,
    category: "tax",
    label: "Tax identification number (TIN)",
    description:
      "The company's LHDN TIN. Needed before anything can be submitted to MyInvois, and printed on invoices. Not a secret; the API credentials are, and they live in the environment rather than here. See Q-FIN-2.",
    needsReview: true,
  },
  {
    key: "einvoice.enabled",
    value: false,
    category: "tax",
    label: "MyInvois e-Invoice enabled",
    description: "Adapter built against sandbox only. Awaiting TIN and credentials. See Q-FIN-2.",
    needsReview: true,
    requiresApproval: true,
  },

  // HR — see Q-HR-1/2
  { key: "hr.work_start", value: "09:00", category: "hr", label: "Scheduled start" },
  { key: "hr.work_end", value: "18:00", category: "hr", label: "Scheduled end" },
  { key: "hr.break_minutes", value: 60, category: "hr", label: "Unpaid break (minutes)" },
  { key: "hr.work_days", value: [1, 2, 3, 4, 5], category: "hr", label: "Working days", description: "1 = Monday." },
  { key: "hr.late_grace_minutes", value: 10, category: "hr", label: "Late grace period (minutes)", needsReview: true },

  // Whether an overtime payment is "wages", per contribution. Three answers, not one, which is why
  // these are data. See Q-HR-1 item 7 and migration 0034.
  {
    key: "payroll.overtime_is_epf_wages",
    value: false,
    category: "hr",
    label: "Overtime counts as wages for EPF",
    description:
      "Off, which is the ordinary treatment: KWSP lists overtime among the payments not subject to contribution. Confirming this is CAC's accountant adopting it.",
    needsReview: true,
  },
  {
    key: "payroll.overtime_is_socso_wages",
    value: true,
    category: "hr",
    label: "Overtime counts as wages for SOCSO and EIS",
    description:
      "On, which is the ordinary treatment: PERKESO includes overtime payments in wages for contribution, and EIS uses the same definition.",
    needsReview: true,
  },
  {
    key: "payroll.overtime_is_pcb_wages",
    value: true,
    category: "hr",
    label: "Overtime counts as wages for PCB",
    description:
      "On, which is the ordinary treatment: overtime is remuneration from employment, so the monthly tax deduction is computed on it.",
    needsReview: true,
  },
  { key: "hr.ot_requires_approval", value: true, category: "hr", label: "Overtime requires prior approval" },
  {
    key: "hr.ot_rates",
    value: null,
    category: "hr",
    label: "Overtime rate multipliers",
    description:
      "UNSET. No overtime rate is applied until the official schedule is confirmed. Extra time is still recorded. See Q-HR-1.",
    needsReview: true,
    requiresApproval: true,
  },
  { key: "hr.payroll_cutoff_day", value: 25, category: "hr", label: "Payroll cut-off day" },
  { key: "hr.pay_date", value: "last_working_day", category: "hr", label: "Pay date" },
  {
    key: "hr.statutory_source_confirmed",
    value: false,
    category: "hr",
    label: "Statutory schedules confirmed",
    description:
      "EPF/SOCSO/EIS/PCB tables must come from official current schedules. Payroll will not finalise while this is false. See Q-HR-1.",
    needsReview: true,
    requiresApproval: true,
  },

  // Security
  { key: "security.session_idle_minutes", value: 30, category: "security", label: "Session idle timeout (minutes)" },
  { key: "security.session_absolute_hours", value: 12, category: "security", label: "Session absolute lifetime (hours)" },
  { key: "security.password_min_length", value: 12, category: "security", label: "Minimum password length" },
  { key: "security.mfa_required_roles", value: ["SUPER_ADMIN", "DIRECTOR", "MANAGEMENT", "ACCOUNTANT", "HR_ADMIN", "HR_MANAGER"], category: "security", label: "Roles requiring MFA" },
  { key: "security.max_failed_attempts", value: 5, category: "security", label: "Failed attempts before lockout" },
  {
    key: "security.mfa_enrolment_grace_days",
    value: 7,
    category: "security",
    label: "Days to enrol an authenticator",
    description:
      "How long an account required to hold an authenticator may keep working before it is shut out of everything but its own account page. Seven days is the usual rollout window, and the reminder appears on every page until then. Nought enforces immediately.",
  },
  { key: "security.lockout_minutes", value: 15, category: "security", label: "Lockout duration (minutes)" },

  // Cases / AI — see Q-LEGAL-1/2, Q-AI-1
  {
    key: "ai.external_provider_enabled",
    value: false,
    category: "ai",
    label: "External AI provider enabled",
    description:
      "Kill switch. While false the agent is retrieval-only and no case content leaves the system. See Q-AI-1.",
    needsReview: true,
    requiresApproval: true,
  },
  {
    key: "cases.age_of_majority",
    value: null,
    category: "cases",
    label: "Age of majority",
    description:
      "UNSET. The agent's consistency check compares a party's date of birth with the minor flag, and cannot without this. A figure here is a statement about Malaysian law, so it takes a source as well - see cases.age_of_majority_source. Nothing is guessed.",
    needsReview: true,
    requiresApproval: true,
  },
  {
    key: "cases.age_of_majority_source",
    value: null,
    category: "cases",
    label: "Source for the age of majority",
    description:
      "The authority the figure above was taken from. The check stays off until both are set, for the same reason a statutory payroll rate needs a citation.",
    needsReview: true,
  },
  {
    key: "cases.legal_reviewer_confirmed",
    value: false,
    category: "cases",
    label: "Authorised legal reviewer appointed",
    description:
      "No generated legal document may be approved until a named, qualified reviewer holds case.document.approve. See Q-LEGAL-1.",
    needsReview: true,
    requiresApproval: true,
  },
];

const SEQUENCES = [
  { key: "invoice", prefix: "INV" },
  { key: "quotation", prefix: "QT" },
  { key: "credit_note", prefix: "CN" },
  { key: "receipt", prefix: "RCP" },
  { key: "voucher", prefix: "PV" },
  { key: "purchase_order", prefix: "PO" },
  { key: "journal", prefix: "JV" },
  { key: "petty_cash", prefix: "PC" },
  { key: "claim", prefix: "CLM" },
  { key: "reconciliation", prefix: "BR" },
  { key: "employee", prefix: "EMP" },
  { key: "leave", prefix: "LV" },
  { key: "overtime", prefix: "OT" },
  { key: "timeoff", prefix: "TO" },
  { key: "payroll", prefix: "PR" },
  { key: "letter", prefix: "LTR" },
  { key: "case", prefix: "CASE" },
  { key: "document", prefix: "DOC" },
  { key: "case_document", prefix: "CDOC" },
];

export async function seed(db?: Database): Promise<void> {
  const database = db ?? (await getDb());

  // Roles
  for (const [key, description] of Object.entries(ROLES)) {
    await database.execute(sql`
      INSERT INTO auth.role (key, name, description, is_system)
      VALUES (${key}, ${key.replace(/_/g, " ")}, ${description}, true)
      ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description
    `);
  }

  // Capability catalogue
  for (const p of ALL_PERMISSIONS) {
    await database.execute(sql`
      INSERT INTO auth.permission (key, domain, description)
      VALUES (${p.key}, ${p.domain}, ${p.description})
      ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, domain = EXCLUDED.domain
    `);
  }

  // Role bundles. Rebuilt from the catalogue each run so the database always
  // matches docs/RBAC_MATRIX.md rather than drifting from it.
  for (const [roleKey, permissionKeys] of Object.entries(ROLE_PERMISSIONS)) {
    const unique = [...new Set(permissionKeys)];
    await database.execute(sql`
      DELETE FROM auth.role_permission
      WHERE role_id = (SELECT id FROM auth.role WHERE key = ${roleKey})
    `);
    for (const permissionKey of unique) {
      await database.execute(sql`
        INSERT INTO auth.role_permission (role_id, permission_id)
        SELECT r.id, p.id FROM auth.role r, auth.permission p
        WHERE r.key = ${roleKey} AND p.key = ${permissionKey}
        ON CONFLICT DO NOTHING
      `);
    }
  }

  // Settings — never overwrite a value CAC has already set.
  for (const s of SETTINGS) {
    await database.execute(sql`
      INSERT INTO org.setting (key, value, category, label, description, needs_review, requires_approval)
      VALUES (${s.key}, ${JSON.stringify(s.value)}::jsonb, ${s.category}, ${s.label},
              ${s.description ?? null}, ${s.needsReview ?? false}, ${s.requiresApproval ?? false})
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        category = EXCLUDED.category
    `);
  }

  for (const s of SEQUENCES) {
    await database.execute(sql`
      INSERT INTO org.document_sequence (key, prefix) VALUES (${s.key}, ${s.prefix})
      ON CONFLICT (key) DO NOTHING
    `);
  }

  await seedTaxCodes(database);
  await seedChartOfAccounts(database);
}

/**
 * Tax codes only — never rates. A rate is a statutory assertion and needs a
 * citation, which only a person can supply. See the comment on TAX_CODES.
 */
async function seedTaxCodes(database: Database): Promise<void> {
  for (const t of TAX_CODES) {
    // SST codes stay inactive until someone enters a rate for them, so they
    // cannot be picked on an invoice and silently charge nothing.
    const isActive = t.kind === "none" || t.kind === "exempt";
    await database.execute(sql`
      INSERT INTO accounting.tax_code (code, name, kind, is_active)
      VALUES (${t.code}, ${t.name}, ${t.kind}, ${isActive})
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind
    `);
  }
}

/**
 * The chart of accounts.
 *
 * Idempotent, and deliberately conservative on re-run: an existing account's
 * name and description are refreshed, but its parent, type, side and active
 * state are left alone. Once there are postings, changing an account's type
 * would silently restate reports that have already been filed.
 */
async function seedChartOfAccounts(database: Database): Promise<void> {
  for (const a of CHART_OF_ACCOUNTS) {
    const normalSide = normalSideFor(a);
    await database.execute(sql`
      INSERT INTO accounting.account
        (code, name, type, subtype, parent_id, normal_side, is_postable, is_system, is_contra, description)
      VALUES (
        ${a.code}, ${a.name}, ${a.type}, ${a.subtype ?? null},
        (SELECT id FROM accounting.account WHERE code = ${a.parent ?? null}),
        ${normalSide}, ${!a.header}, ${a.system ?? false}, ${a.contra ?? false},
        ${a.description ?? null}
      )
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        subtype = EXCLUDED.subtype
    `);
  }

  // A mismatch here means coa.ts was edited in one place and not the other:
  // a module would resolve an account by code that the seed has not protected.
  for (const [key, code] of Object.entries(SYSTEM_ACCOUNTS)) {
    const row = await database.execute<{ is_system: boolean }>(sql`
      SELECT is_system FROM accounting.account WHERE code = ${code}
    `);
    const found = row.rows?.[0];
    if (!found) {
      throw new Error(`SYSTEM_ACCOUNTS.${key} points at account ${code}, which is not in the chart.`);
    }
    if (!found.is_system) {
      throw new Error(`Account ${code} is used as SYSTEM_ACCOUNTS.${key} but is not marked system.`);
    }
  }
}

/**
 * Assets and expenses are debit-normal, the rest credit-normal, and a contra
 * account is the reverse. Derived rather than stored in coa.ts so the two can
 * never disagree.
 */
function normalSideFor(a: AccountSeed): "debit" | "credit" {
  const debitNormal = a.type === "ASSET" || a.type === "EXPENSE";
  const positive = debitNormal ? "debit" : "credit";
  const negative = debitNormal ? "credit" : "debit";
  return a.contra ? negative : positive;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  (async () => {
    const applied = await runMigrations();
    if (applied.length) console.log(`Applied ${applied.length} migration(s).`);
    await seed();
    console.log(
      "Seed complete: roles, capabilities, settings, sequences, tax codes and chart of accounts.",
    );
    await closeDb();
    process.exit(0);
  })().catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
}
