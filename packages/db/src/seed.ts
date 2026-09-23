import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { getDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import { ALL_PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "./rbac.js";

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
  { key: "company.timezone", value: "Asia/Kuala_Lumpur", category: "company", label: "Timezone" },
  { key: "company.currency", value: "MYR", category: "company", label: "Operating currency" },

  // Accounting — see OPEN_QUESTIONS Q-FIN-1/3/4
  { key: "accounting.fiscal_year_start_month", value: 1, category: "accounting", label: "Fiscal year starts in month", description: "1 = January. Confirm with CAC's accountant.", needsReview: true },
  { key: "accounting.period_length", value: "monthly", category: "accounting", label: "Accounting period length" },
  { key: "accounting.invoice_terms_days", value: 30, category: "accounting", label: "Default invoice payment terms (days)" },
  { key: "accounting.quotation_validity_days", value: 30, category: "accounting", label: "Default quotation validity (days)" },
  { key: "accounting.aging_buckets", value: [30, 60, 90], category: "accounting", label: "AR aging bucket boundaries (days)" },
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
  { key: "receipt", prefix: "RCP" },
  { key: "voucher", prefix: "PV" },
  { key: "purchase_order", prefix: "PO" },
  { key: "journal", prefix: "JV" },
  { key: "petty_cash", prefix: "PC" },
  { key: "claim", prefix: "CLM" },
  { key: "case", prefix: "CASE" },
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
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  (async () => {
    const applied = await runMigrations();
    if (applied.length) console.log(`Applied ${applied.length} migration(s).`);
    await seed();
    console.log("Seed complete: roles, capabilities, settings and sequences.");
    process.exit(0);
  })().catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
}
