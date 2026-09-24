/**
 * The capability catalogue and the role bundles built from it.
 *
 * This file is the source of truth for `docs/RBAC_MATRIX.md`. Application code
 * always asks for a capability (`accounting.invoice.approve`) and never for a
 * role name, so that changing who may do something is a data change rather
 * than a code change.
 *
 * Capabilities for later phases are declared here from the start. Declaring
 * them early costs nothing and means a module cannot quietly ship without an
 * authorisation story.
 */

export const PERMISSIONS = {
  accounting: [
    ["accounting.coa.view", "View the chart of accounts"],
    ["accounting.coa.manage", "Create and amend accounts"],
    ["accounting.invoice.view", "View invoices"],
    ["accounting.invoice.create", "Create and edit draft invoices"],
    ["accounting.invoice.approve", "Approve invoices within the configured limit"],
    ["accounting.invoice.approve_high_value", "Approve invoices above the configured limit"],
    ["accounting.invoice.issue", "Issue approved invoices"],
    ["accounting.invoice.void", "Void or credit an issued invoice"],
    ["accounting.quotation.view", "View quotations"],
    ["accounting.quotation.create", "Create and edit quotations"],
    ["accounting.quotation.approve", "Approve quotations"],
    ["accounting.quotation.convert", "Convert a quotation to an invoice"],
    ["accounting.receipt.view", "View customer receipts"],
    ["accounting.receipt.create", "Record customer receipts"],
    ["accounting.receipt.allocate", "Allocate receipts against invoices"],
    ["accounting.receipt.approve", "Approve receipts"],
    ["accounting.voucher.view", "View payment vouchers"],
    ["accounting.voucher.create", "Create payment vouchers"],
    ["accounting.voucher.approve", "Approve payment vouchers within the configured limit"],
    ["accounting.voucher.approve_high_value", "Approve payment vouchers above the configured limit"],
    ["accounting.voucher.pay", "Mark a voucher paid"],
    ["accounting.po.view", "View purchase orders"],
    ["accounting.po.create", "Create purchase orders"],
    ["accounting.po.approve", "Approve purchase orders"],
    ["accounting.po.receive", "Record receipt of goods or services"],
    ["accounting.po.close", "Close a purchase order"],
    ["accounting.pettycash.view", "View petty cash"],
    ["accounting.pettycash.create", "Record petty cash movements"],
    ["accounting.pettycash.approve", "Approve petty cash"],
    ["accounting.pettycash.reconcile", "Reconcile petty cash"],
    ["accounting.claim.view", "View expense claims"],
    ["accounting.claim.create", "Submit an expense claim"],
    ["accounting.claim.approve", "Approve expense claims"],
    ["accounting.claim.reimburse", "Mark a claim reimbursed"],
    ["accounting.journal.view", "View journals and the general ledger"],
    ["accounting.journal.create", "Create manual journals"],
    ["accounting.journal.post", "Post journals to the ledger"],
    ["accounting.journal.reverse", "Reverse a posted journal"],
    ["accounting.period.view", "View accounting periods"],
    ["accounting.period.manage", "Set up fiscal years and accounting periods"],
    ["accounting.period.lock", "Lock an accounting period"],
    ["accounting.period.close", "Close an accounting period or fiscal year"],
    ["accounting.tax.view", "View tax configuration"],
    ["accounting.tax.manage", "Amend tax codes and rates"],
    ["accounting.bank.view", "View bank accounts"],
    ["accounting.bank.import", "Import bank statements"],
    ["accounting.bank.reconcile", "Reconcile bank accounts"],
    ["accounting.report.view", "View financial reports"],
    ["accounting.report.export", "Export financial reports"],
    ["accounting.einvoice.submit", "Submit e-Invoices"],
    ["accounting.einvoice.cancel", "Cancel a submitted e-Invoice"],
    ["accounting.einvoice.view", "View e-Invoice status"],
    ["accounting.customer.view", "View customers"],
    ["accounting.customer.manage", "Create and amend customers"],
    ["accounting.supplier.view", "View suppliers"],
    ["accounting.supplier.manage", "Create and amend suppliers"],
  ],
  hr: [
    ["hr.employee.view", "View employee records"],
    ["hr.employee.view_sensitive", "View NRIC, bank and salary details"],
    ["hr.employee.create", "Create employee records"],
    ["hr.employee.edit", "Amend employee records"],
    ["hr.employee.terminate", "Record termination"],
    ["hr.attendance.view", "View attendance"],
    ["hr.attendance.import", "Import attendance from the device export"],
    ["hr.attendance.edit", "Correct attendance records"],
    ["hr.attendance.finalise", "Finalise attendance for a period"],
    ["hr.schedule.view", "View work schedules"],
    ["hr.schedule.manage", "Create and amend work schedules"],
    ["hr.overtime.view", "View overtime"],
    ["hr.overtime.request", "Request overtime"],
    ["hr.overtime.approve", "Approve overtime"],
    ["hr.leave.view", "View leave"],
    ["hr.leave.request", "Request leave"],
    ["hr.leave.approve", "Approve leave"],
    ["hr.leave.manage_types", "Configure leave types"],
    ["hr.leave.manage_balance", "Adjust leave balances"],
    ["hr.timeoff.request", "Request time off or early clock-out"],
    ["hr.timeoff.approve", "Approve time off or early clock-out"],
    ["hr.payroll.view", "View payroll runs"],
    ["hr.payroll.prepare", "Prepare a payroll run"],
    ["hr.payroll.approve", "Approve a payroll run"],
    ["hr.payroll.finalise", "Finalise a payroll run"],
    ["hr.payroll.post", "Post payroll to the ledger"],
    ["hr.payslip.view_own", "View own payslips"],
    ["hr.payslip.view_all", "View any payslip"],
    ["hr.appraisal.view", "View appraisals"],
    ["hr.appraisal.manage", "Configure appraisal cycles"],
    ["hr.appraisal.review", "Complete an appraisal review"],
    ["hr.letter.generate", "Generate employment letters"],
    ["hr.letter.approve", "Approve employment letters"],
    ["hr.statutory.view", "View statutory rule versions"],
    ["hr.statutory.manage", "Amend statutory rule versions"],
  ],
  cases: [
    ["case.view", "View assigned cases"],
    ["case.view_all", "View every case"],
    ["case.create", "Open a case"],
    ["case.edit", "Amend case details"],
    ["case.assign", "Assign case staff"],
    ["case.close", "Close a case"],
    ["case.document.upload", "Upload case documents"],
    ["case.document.view", "View case documents"],
    ["case.document.download", "Download case documents"],
    ["case.document.delete", "Remove a case document"],
    ["case.document.generate", "Generate a case document from a template"],
    ["case.document.approve", "Approve a generated legal document"],
    ["case.checklist.manage", "Amend a case checklist"],
    ["case.task.view", "View case tasks"],
    ["case.task.manage", "Create and assign case tasks"],
    ["case.agent.run", "Run the estate case agent"],
    ["case.fact.verify", "Mark a case fact verified"],
    ["case.rule.view", "View case rules"],
    ["case.rule.propose", "Propose a case rule change"],
    ["case.rule.approve", "Approve a case rule"],
  ],
  docs: [
    ["doc.view", "View documents"],
    ["doc.upload", "Upload documents"],
    ["doc.download", "Download documents"],
    ["doc.delete", "Delete documents"],
    ["doc.archive", "Archive documents"],
    ["template.view", "View templates"],
    ["template.manage", "Create and amend templates"],
    ["template.approve", "Approve a template version"],
  ],
  admin: [
    ["admin.user.manage", "Create, suspend and amend user accounts"],
    ["admin.role.manage", "Assign roles and permissions"],
    ["admin.settings.manage", "Amend company settings"],
    ["admin.integration.manage", "Configure integrations"],
    ["audit.view", "View the audit trail"],
    ["audit.export", "Export the audit trail"],
  ],
} as const satisfies Record<string, readonly (readonly [string, string])[]>;

export type PermissionKey =
  (typeof PERMISSIONS)[keyof typeof PERMISSIONS][number][0];

export const ALL_PERMISSIONS = Object.entries(PERMISSIONS).flatMap(([domain, list]) =>
  list.map(([key, description]) => ({ key, domain, description })),
);

export const ROLES = {
  SUPER_ADMIN: "Platform administration. Not an everyday account.",
  DIRECTOR: "Company leadership. Final approval above thresholds.",
  MANAGEMENT: "Senior oversight, reporting and approvals within limits.",
  ACCOUNTANT: "Owns the ledger: posting, periods and statutory reporting.",
  ACCOUNTS_EXECUTIVE: "Prepares accounting documents. Cannot approve or post.",
  HR_ADMIN: "HR operations, attendance, leave and payroll preparation.",
  HR_MANAGER: "HR oversight and payroll approval.",
  CASE_MANAGER: "Owns estate cases end to end.",
  CASE_STAFF: "Works assigned cases. Cannot approve legal documents.",
  LAWYER_OR_AUTHORISED_REVIEWER: "Approves legal documents and case rules.",
  EMPLOYEE: "Self-service only: own payslips, leave, claims and attendance.",
  AUDITOR: "Reads everything, changes nothing.",
  READ_ONLY: "Limited read access for observers.",
} as const;

export type RoleKey = keyof typeof ROLES;

const has = (prefix: string) =>
  ALL_PERMISSIONS.filter((p) => p.key.startsWith(prefix)).map((p) => p.key);

const readOnlyOf = (prefix: string) =>
  ALL_PERMISSIONS.filter(
    (p) => p.key.startsWith(prefix) && /\.(view|view_all|view_own)$/.test(p.key),
  ).map((p) => p.key);

/**
 * Role → capability bundles, mirroring docs/RBAC_MATRIX.md.
 *
 * SUPER_ADMIN deliberately does NOT receive every capability. It administers
 * users, roles and settings; it does not approve invoices or post payroll.
 * Blanket super-users defeat maker/checker and make the audit trail
 * meaningless.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, string[]> = {
  SUPER_ADMIN: [...has("admin."), ...has("audit."), "accounting.coa.view", "hr.employee.view", "case.view_all"],

  DIRECTOR: [
    ...readOnlyOf("accounting."),
    "accounting.invoice.approve", "accounting.invoice.approve_high_value",
    "accounting.invoice.void",
    "accounting.receipt.approve",
    "accounting.voucher.approve", "accounting.voucher.approve_high_value",
    "accounting.po.approve", "accounting.pettycash.approve",
    "accounting.claim.approve", "accounting.journal.reverse",
    "accounting.period.manage", "accounting.period.close", "accounting.report.export",
    ...readOnlyOf("hr."), "hr.employee.view_sensitive",
    "hr.overtime.approve", "hr.leave.approve", "hr.timeoff.approve",
    "hr.payroll.approve", "hr.payroll.finalise", "hr.payslip.view_all",
    "hr.letter.approve", "hr.statutory.manage",
    ...readOnlyOf("case."), "case.view_all", "case.agent.run",
    "case.document.approve", "case.rule.approve",
    "admin.settings.manage", "audit.view", "audit.export",
    "accounting.claim.create", "hr.leave.request", "hr.payslip.view_own",
  ],

  MANAGEMENT: [
    ...readOnlyOf("accounting."), "accounting.report.export",
    "accounting.invoice.approve", "accounting.voucher.approve",
    "accounting.pettycash.approve", "accounting.claim.approve",
    ...readOnlyOf("hr."), "hr.overtime.approve", "hr.leave.approve", "hr.timeoff.approve",
    ...readOnlyOf("case."), "case.view_all",
    "accounting.claim.create", "hr.leave.request", "hr.payslip.view_own",
  ],

  ACCOUNTANT: [
    // Everything in accounting except the high-value approvals. Owning the ledger
    // is not the same as being the final word on a large customer invoice or a
    // large payment out, and `has()` would hand over both.
    ...has("accounting.").filter((key) => !key.endsWith(".approve_high_value")),
    "hr.payroll.post", "hr.statutory.view",
    "accounting.claim.create", "hr.leave.request", "hr.payslip.view_own",
  ],

  ACCOUNTS_EXECUTIVE: [
    ...readOnlyOf("accounting."),
    "accounting.invoice.create", "accounting.quotation.create",
    "accounting.receipt.create", "accounting.receipt.allocate",
    "accounting.voucher.create", "accounting.po.create",
    "accounting.pettycash.create", "accounting.claim.create",
    "accounting.customer.manage", "accounting.supplier.manage",
    "hr.leave.request", "hr.payslip.view_own",
  ],

  HR_ADMIN: [
    ...readOnlyOf("hr."),
    "hr.employee.view_sensitive", "hr.employee.create", "hr.employee.edit",
    "hr.attendance.import", "hr.attendance.edit",
    "hr.schedule.manage", "hr.overtime.approve",
    "hr.leave.approve", "hr.leave.manage_types", "hr.leave.manage_balance",
    "hr.timeoff.approve", "hr.payroll.prepare",
    "hr.payslip.view_all", "hr.letter.generate", "hr.appraisal.manage",
    "accounting.claim.approve", "accounting.claim.create", "hr.leave.request", "hr.payslip.view_own",
  ],

  HR_MANAGER: [
    ...has("hr."),
    "accounting.claim.approve", "accounting.claim.create",
  ],

  CASE_MANAGER: [
    ...has("case."),
    "doc.view", "doc.upload", "doc.download", "template.view",
    "accounting.invoice.view", "hr.overtime.approve", "hr.leave.approve",
    "accounting.claim.create", "hr.leave.request", "hr.payslip.view_own",
  ],

  CASE_STAFF: [
    "case.view", "case.edit", "case.document.upload", "case.document.view",
    "case.document.download", "case.document.generate", "case.task.view",
    "case.agent.run", "case.checklist.manage", "case.rule.view",
    "doc.view", "doc.upload", "doc.download", "template.view",
    "accounting.claim.create", "hr.leave.request", "hr.payslip.view_own",
  ],

  LAWYER_OR_AUTHORISED_REVIEWER: [
    ...readOnlyOf("case."), "case.view_all", "case.agent.run",
    "case.document.generate", "case.document.approve",
    "case.fact.verify", "case.rule.propose", "case.rule.approve",
    "doc.view", "doc.download", "template.view", "template.approve",
  ],

  EMPLOYEE: [
    "hr.payslip.view_own", "hr.leave.request", "hr.leave.view",
    "hr.overtime.request", "hr.timeoff.request",
    "hr.attendance.view", "accounting.claim.create", "accounting.claim.view",
  ],

  AUDITOR: [
    ...readOnlyOf("accounting."), ...readOnlyOf("hr."), ...readOnlyOf("case."),
    "accounting.journal.view", "accounting.report.view", "accounting.report.export",
    "hr.employee.view_sensitive", "hr.payslip.view_all",
    "doc.view", "audit.view", "audit.export",
  ],

  READ_ONLY: [
    "accounting.invoice.view", "accounting.report.view",
    "hr.employee.view", "case.view", "doc.view",
  ],
};

/**
 * Capabilities that may never be held together by one person on one document.
 * Enforced at the point of approval, not only by role design — a user could
 * legitimately hold both across different documents.
 */
export const MAKER_CHECKER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["accounting.invoice.create", "accounting.invoice.approve"],
  ["accounting.voucher.create", "accounting.voucher.approve"],
  ["accounting.claim.create", "accounting.claim.approve"],
  ["accounting.journal.create", "accounting.journal.post"],
  ["hr.payroll.prepare", "hr.payroll.approve"],
  ["case.document.generate", "case.document.approve"],
];
